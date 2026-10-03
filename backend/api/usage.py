"""
usage.py
--------
Server-side enforcement + bookkeeping for the three independent check
balances (`profiles.standard_credits`, `profiles.premium_credits`, and the
plan-based `checks_used_this_period` vs `plan_definitions.doc_limit`).
apps/web's local display of these values is cosmetic only — this module is
the actual gate, and (along with the admin dashboard and the
RLS-lockdown-exempt service role) the only writer of these columns
(supabase/migrations/20260719000000_lock_down_profile_self_updates.sql
blocks everyone else from touching them).

Callers pick which balance to spend per check (`balance_source`, one of
"plan" | "standard" | "premium") — see ensure_quota_available() and
record_check_used() below.

Deduction happens on SUCCESS only, from the job runners in app.py, not at
submission — a crashed/failed job should never cost the user a check. This
means two check jobs submitted back-to-back before either finishes can both
pass ensure_quota_available() and both succeed, over-spending by one in that
narrow race; accepted tradeoff in exchange for never charging a failed job.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException

from supabase_client import get_client

logger = logging.getLogger(__name__)

PLAN_PERIOD_DAYS = 30
_DOC_LIMIT_CACHE_TTL_SECONDS = 60.0
_doc_limit_cache: dict[str, tuple[float, Optional[int]]] = {}


def _get_plan_doc_limit(plan_tier: str) -> Optional[int]:
    """Monthly check allowance for a plan, from `plan_definitions.doc_limit`.
    None means unlimited (or lookup unavailable — fails open, matching
    _fetch_profile_usage's fail-open posture below)."""
    now = time.time()
    cached = _doc_limit_cache.get(plan_tier)
    if cached is not None and (now - cached[0]) < _DOC_LIMIT_CACHE_TTL_SECONDS:
        return cached[1]

    client = get_client()
    limit: Optional[int] = None
    if client is not None:
        try:
            resp = (
                client.table("plan_definitions")
                .select("doc_limit")
                .eq("id", plan_tier)
                .maybe_single()
                .execute()
            )
            if resp and resp.data:
                limit = resp.data.get("doc_limit")
        except Exception:
            logger.exception("Failed to fetch doc_limit for plan_tier=%s", plan_tier)

    _doc_limit_cache[plan_tier] = (now, limit)
    return limit


@dataclass
class ProfileUsage:
    plan_tier: str
    standard_credits: int
    premium_credits: int
    checks_used_this_period: int
    plan_period_start: Optional[str]
    plan_expires_at: Optional[str] = None

    @property
    def effective_plan_tier(self) -> str:
        """The plan in force right now. A paid plan whose term has ended counts
        as Free immediately, even before expire_lapsed_plans() (pg_cron, every
        10 minutes) writes the downgrade."""
        if self.plan_tier != "free" and _has_lapsed(self.plan_expires_at):
            return "free"
        return self.plan_tier


def _fetch_profile_usage(user_id: str) -> Optional[ProfileUsage]:
    client = get_client()
    if client is None:
        return None
    try:
        resp = (
            client.table("profiles")
            .select("plan_tier, standard_credits, premium_credits, checks_used_this_period, plan_period_start, plan_expires_at")
            .eq("id", user_id)
            .single()
            .execute()
        )
    except Exception:
        logger.exception("Failed to fetch profile usage for user_id=%s", user_id)
        return None

    data = resp.data if resp else None
    if not data:
        return None

    return ProfileUsage(
        plan_tier=data.get("plan_tier") or "free",
        standard_credits=int(data.get("standard_credits") or 0),
        premium_credits=int(data.get("premium_credits") or 0),
        checks_used_this_period=int(data.get("checks_used_this_period") or 0),
        plan_period_start=data.get("plan_period_start"),
        plan_expires_at=data.get("plan_expires_at"),
    )


def _has_lapsed(plan_expires_at: Optional[str]) -> bool:
    """True once a paid term's end has passed. No end date = never lapses."""
    if not plan_expires_at:
        return False
    try:
        end = datetime.fromisoformat(re.sub(r"\.(\d+)", lambda m: "." + (m.group(1) + "000000")[:6], plan_expires_at.replace("Z", "+00:00")))
    except ValueError:
        return False
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) >= end


def _period_elapsed(plan_period_start: Optional[str]) -> bool:
    if not plan_period_start:
        return False
    try:
        start = datetime.fromisoformat(plan_period_start.replace("Z", "+00:00"))
    except ValueError:
        return False
    return datetime.now(timezone.utc) >= start + timedelta(days=PLAN_PERIOD_DAYS)


def ensure_quota_available(user_id: str, balance_source: str) -> None:
    """
    Raises 402 if the caller has nothing left in the requested balance
    (`balance_source`, one of "plan" | "standard" | "premium"). Called
    before a check job is accepted — read-only, does not reserve or deduct
    anything (that only happens on success, in record_check_used()).

    Fails open (allows the check) if Supabase isn't configured or the
    profile lookup fails, matching the rest of this backend's posture for
    non-critical-path Supabase reads (e.g. llm_metadata.py's feature-flag
    check) — an outage here shouldn't take down the product's core feature.
    """
    usage = _fetch_profile_usage(user_id)
    if usage is None:
        return

    if balance_source == "standard":
        if usage.standard_credits <= 0:
            raise HTTPException(
                status_code=402,
                detail="You have no standard credits left. Buy more credits to continue.",
            )
        return

    if balance_source == "premium":
        if usage.premium_credits <= 0:
            raise HTTPException(
                status_code=402,
                detail="You have no premium credits left. Buy more credits to continue.",
            )
        return

    # balance_source == "plan"
    # A lapsed plan restarts on Free with a clean count, as expire_lapsed_plans() will write.
    lapsed = usage.effective_plan_tier != usage.plan_tier
    used = 0 if lapsed or _period_elapsed(usage.plan_period_start) else usage.checks_used_this_period
    limit = _get_plan_doc_limit(usage.effective_plan_tier)
    if limit is not None and used >= limit:
        raise HTTPException(
            status_code=402,
            detail="You've used all your checks for this period. Upgrade your plan or buy credits to continue.",
        )


def record_check_used(user_id: str, balance_source: str) -> None:
    """
    Called only after a check job completes successfully. Spends one unit
    from the requested balance (`balance_source`, one of
    "plan" | "standard" | "premium"): decrements standard_credits or
    premium_credits, or increments checks_used_this_period (rolling the
    period over first if it has elapsed) for "plan". Best-effort: logged on
    failure, never raises — the check itself already succeeded and must not
    be undone by a bookkeeping error.
    """
    client = get_client()
    if client is None:
        return

    usage = _fetch_profile_usage(user_id)
    if usage is None:
        return

    try:
        if balance_source == "standard":
            client.table("profiles").update(
                {"standard_credits": usage.standard_credits - 1}
            ).eq("id", user_id).execute()
            return

        if balance_source == "premium":
            client.table("profiles").update(
                {"premium_credits": usage.premium_credits - 1}
            ).eq("id", user_id).execute()
            return

        # balance_source == "plan"
        if _period_elapsed(usage.plan_period_start):
            client.table("profiles").update(
                {
                    "checks_used_this_period": 1,
                    "plan_period_start": datetime.now(timezone.utc).isoformat(),
                }
            ).eq("id", user_id).execute()
        else:
            client.table("profiles").update(
                {"checks_used_this_period": usage.checks_used_this_period + 1}
            ).eq("id", user_id).execute()
    except Exception:
        logger.exception("Failed to record check usage for user_id=%s", user_id)
