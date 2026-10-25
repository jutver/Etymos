"""
recheck_quota.py
----------------
Pricing rules for Save & re-check (PLAN.md): is the next re-check of a
document free, or does it use one check?

A re-check is free while BOTH hold, using the limits of the document's
effective tier (the higher of the owner's plan and documents.unlocked_tier):
  - less than `change_limit` of the text changed since the baseline, counted
    cumulatively (added or replaced words / baseline words; deletions are free);
  - fewer than `free_rechecks` free re-checks used since that baseline.

The baseline is the text of the last *charged* check: the newest paid
re-check in document_checks, or the original upload. A paid re-check becomes
the new baseline, which resets both counters.

Everything here is read from rows only the backend writes (document_checks,
plan_definitions), so the client can display a quote but never set the price.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any, Literal, Optional

from fastapi import HTTPException

from supabase_client import get_client
from usage import _fetch_profile_usage

logger = logging.getLogger(__name__)

Cost = Literal["free", "check"]

TIER_RANK = {"free": 0, "student": 1, "professional": 2}


@dataclass(frozen=True)
class RecheckLimits:
    free_rechecks: int
    change_limit: float


# Used when plan_definitions is unreachable or predates the columns
# (supabase/migrations/20261021000000_document_checks.sql has the same values).
DEFAULT_LIMITS = {
    "free": RecheckLimits(free_rechecks=3, change_limit=0.30),
    "student": RecheckLimits(free_rechecks=6, change_limit=0.50),
    "professional": RecheckLimits(free_rechecks=10, change_limit=0.65),
}

_LIMITS_CACHE_TTL_SECONDS = 60.0
_limits_cache: dict[str, tuple[float, RecheckLimits]] = {}

_WORD_RE = re.compile(r"\w+", re.UNICODE)
_PARAGRAPH_RE = re.compile(r"\n+")


# --- change ratio -------------------------------------------------------------

def _words(text: str) -> list[str]:
    return _WORD_RE.findall(text.lower())


def _paragraphs(text: str) -> list[str]:
    return [" ".join(_words(p)) for p in _PARAGRAPH_RE.split(text) if _words(p)]


def _new_words(old: list[str], new: list[str]) -> int:
    """Words in `new` that were inserted or replaced relative to `old`."""
    count = 0
    for tag, _i1, _i2, j1, j2 in SequenceMatcher(None, old, new, autojunk=False).get_opcodes():
        if tag in ("insert", "replace"):
            count += j2 - j1
    return count


def changed_ratio(baseline: str, current: str) -> float:
    """
    Share of the baseline that was added or replaced, 0..1. Pure deletions
    don't count: removing copied text is the fix we want to encourage, and it
    brings no new text to search.

    Diffs paragraphs first and words only inside the paragraphs that differ,
    so a long document with a few edits stays fast.
    """
    old_paras, new_paras = _paragraphs(baseline), _paragraphs(current)
    baseline_words = sum(len(p.split()) for p in old_paras)
    if baseline_words == 0:
        return 1.0 if new_paras else 0.0

    added = 0
    for tag, i1, i2, j1, j2 in SequenceMatcher(None, old_paras, new_paras, autojunk=False).get_opcodes():
        if tag == "insert":
            added += sum(len(p.split()) for p in new_paras[j1:j2])
        elif tag == "replace":
            old_words = " ".join(old_paras[i1:i2]).split()
            new_words = " ".join(new_paras[j1:j2]).split()
            added += _new_words(old_words, new_words)
    return min(1.0, added / baseline_words)


# --- limits -------------------------------------------------------------------

def effective_tier(plan_tier: Optional[str], unlocked_tier: Optional[str]) -> str:
    """The higher of the plan in force and the document's own tier."""
    plan = plan_tier if plan_tier in TIER_RANK else "free"
    doc = unlocked_tier if unlocked_tier in TIER_RANK else "free"
    return plan if TIER_RANK[plan] >= TIER_RANK[doc] else doc


def get_recheck_limits(tier: str) -> RecheckLimits:
    """Free re-check limits for a tier, from plan_definitions (cached briefly)."""
    default = DEFAULT_LIMITS.get(tier, DEFAULT_LIMITS["free"])
    now = time.time()
    cached = _limits_cache.get(tier)
    if cached is not None and (now - cached[0]) < _LIMITS_CACHE_TTL_SECONDS:
        return cached[1]

    limits = default
    client = get_client()
    if client is not None:
        try:
            resp = (
                client.table("plan_definitions")
                .select("recheck_free_limit, recheck_change_limit")
                .eq("id", tier)
                .maybe_single()
                .execute()
            )
            row = (resp.data if resp else None) or {}
            if row.get("recheck_free_limit") is not None and row.get("recheck_change_limit") is not None:
                limits = RecheckLimits(
                    free_rechecks=int(row["recheck_free_limit"]),
                    change_limit=float(row["recheck_change_limit"]),
                )
        except Exception:
            logger.exception("Failed to fetch re-check limits for tier=%s; using defaults", tier)

    _limits_cache[tier] = (now, limits)
    return limits


def decide_cost(ratio: float, free_used: int, limits: RecheckLimits) -> Cost:
    if ratio < limits.change_limit and free_used < limits.free_rechecks:
        return "free"
    return "check"


# --- history ------------------------------------------------------------------

@dataclass
class CheckHistory:
    # The baseline text, when the history knows it: the newest paid
    # re-check's text, else the upload's text as the first re-check saw it.
    # None means there are no re-checks yet, so the stored passages are still
    # the upload's.
    paid_baseline: Optional[str]
    free_used: int


def load_check_history(document_id: str) -> CheckHistory:
    """
    Free re-checks used since the newest paid re-check, and the baseline
    text. Fails closed (503): a wrong count would hand out free checks.

    A re-check replaces the stored passages, so once one has run they no
    longer hold the upload's text; the oldest row's previous_text does.
    """
    client = get_client()
    if client is None:
        return CheckHistory(paid_baseline=None, free_used=0)
    try:
        resp = (
            client.table("document_checks")
            .select("kind, baseline_text, previous_text")
            .eq("document_id", document_id)
            .order("created_at", desc=True)
            .execute()
        )
    except Exception:
        logger.exception("Failed to load document_checks for document_id=%s", document_id)
        raise HTTPException(status_code=503, detail="Re-check isn't available right now. Please try again shortly.")

    # An "upload" row only keeps the upload's result for Version History.
    rows = [row for row in (resp.data or []) if row.get("kind") != "upload"]
    free_used = 0
    for row in rows:
        if row.get("kind") == "paid_recheck":
            return CheckHistory(paid_baseline=row.get("baseline_text") or "", free_used=free_used)
        free_used += 1
    if rows:
        # Only free re-checks so far: the baseline is still the upload.
        return CheckHistory(paid_baseline=rows[-1].get("previous_text") or "", free_used=free_used)
    return CheckHistory(paid_baseline=None, free_used=0)


def original_text(report_id: str, report: dict[str, Any]) -> str:
    """
    The uploaded document's text, one paragraph per line. Prefers the stored
    passages, which are the same blocks the Report editor shows (so unchanged
    paragraphs diff as unchanged), then the report's own input_text.
    """
    client = get_client()
    if client is not None:
        try:
            resp = (
                client.table("document_passages")
                .select("text")
                .eq("document_id", report_id)
                .order("sort_order")
                .execute()
            )
            texts = [(r.get("text") or "").strip() for r in (resp.data or [])]
            if any(texts):
                return "\n\n".join(t for t in texts if t)
        except Exception:
            logger.exception("Failed to load passages for report_id=%s", report_id)
    return report.get("input_text") or ""


# --- quote --------------------------------------------------------------------

def quote_recheck(report_id: str, report: dict[str, Any], current_text: str) -> dict[str, Any]:
    """What re-checking `current_text` would cost. Read-only."""
    history = load_check_history(report_id)
    baseline = history.paid_baseline if history.paid_baseline is not None else original_text(report_id, report)

    owner = report.get("user_id")
    profile = _fetch_profile_usage(owner) if owner else None
    plan_tier = profile.effective_plan_tier if profile is not None else "free"
    tier = effective_tier(plan_tier, report.get("unlocked_tier"))
    limits = get_recheck_limits(tier)

    ratio = changed_ratio(baseline, current_text)
    return {
        "tier": tier,
        "changed_ratio": round(ratio, 4),
        "change_limit": limits.change_limit,
        "free_used": history.free_used,
        "free_limit": limits.free_rechecks,
        "free_left": max(0, limits.free_rechecks - history.free_used),
        "cost": decide_cost(ratio, history.free_used, limits),
    }
