from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from supabase_client import get_client

logger = logging.getLogger(__name__)

REPORT_DIR = Path(os.getenv(
    "REPORT_DIR",
    "/content/drive/MyDrive/Check_Dao_Van/api_reports"
    if os.path.exists("/content/drive/MyDrive") else "./api_reports",
))
_REPORTS: dict[str, dict[str, Any]] = {}
_LOCK = threading.Lock()

# label -> documents.status-style severity bucket, used per-match below.
_LABEL_SEVERITY = {
    "likely_plagiarism": "high",
    "suspicious": "moderate",
    "common_academic_definition": "low",
}

# Cap how many individual sentence matches we normalize into
# `document_matches` per report, to keep the write bounded/cheap. The full
# match list always remains available in the local/in-memory report cache.
_MAX_PERSISTED_MATCHES = 50


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def init_report_store() -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)


def _status_from_score(score: float) -> str:
    """
    Map the pipeline's overall_score (0-100) onto the severity buckets
    allowed by documents.status's check constraint
    (supabase/migrations/20260715120100_documents.sql): clean/low/moderate/high.
    """
    if score >= 30:
        return "high"
    if score >= 10:
        return "moderate"
    if score > 0:
        return "low"
    return "clean"


def _persist_to_supabase(report_id: str, report: dict[str, Any], *,
                          user_id: Optional[str], input_type: str,
                          input_name: Optional[str]) -> None:
    """
    Upsert the completed report into Supabase (`documents` +
    `document_matches`) so it survives a process restart / redeploy, not
    just the lifetime of this container's local disk / in-memory cache.
    Best-effort: any failure is logged, never raised, so a Supabase outage
    can't break the API response the caller already has.
    """
    client = get_client()
    if client is None or user_id is None:
        # No Supabase configured (local dev), or no authenticated owner to
        # scope this report to (e.g. a bare script run) — nothing to persist.
        return

    overall_score = float(report.get("overall_score", 0.0) or 0.0)

    try:
        document_row = {
            "id": report_id,
            "user_id": user_id,
            "title": input_name or ("Pasted text" if input_type == "text" else "Untitled"),
            "file_name": input_name if input_type == "pdf" else None,
            "status": _status_from_score(overall_score),
            "similarity_score": overall_score,
            "uploaded_at": _now_iso(),
        }
        client.table("documents").upsert(document_row, on_conflict="id").execute()
    except Exception:
        logger.exception("Failed to upsert documents row for report_id=%s", report_id)
        return  # No point trying to insert matches for a document row that didn't land.

    try:
        matches = report.get("matches") or []
        rows = []
        for m in matches[:_MAX_PERSISTED_MATCHES]:
            semantic_similarity = float(m.get("semantic_similarity", 0.0) or 0.0)
            rows.append({
                "document_id": report_id,
                "severity": _LABEL_SEVERITY.get(m.get("label"), "low"),
                "detection_type": "semantic",
                "match_percent": round(semantic_similarity * 100, 2),
                "source_title": m.get("source_title") or None,
                "source_author": None,
                "source_kind": None,
                "citation": None,
                "user_snippet": m.get("input_sentence") or None,
                "source_snippet": m.get("source_sentence") or None,
                "explanation": (
                    f"word overlap {m.get('word_overlap', 0):.2f}, "
                    f"char n-gram overlap {m.get('char_ngram_overlap', 0):.2f}"
                    if m.get("word_overlap") is not None else None
                ),
                "rewrite_suggestions": None,
            })
        # Idempotent re-save: clear any previous match rows for this
        # document before inserting the current set.
        client.table("document_matches").delete().eq("document_id", report_id).execute()
        if rows:
            client.table("document_matches").insert(rows).execute()
    except Exception:
        logger.exception("Failed to persist document_matches for report_id=%s", report_id)


def _delete_from_supabase(report_id: str) -> bool:
    client = get_client()
    if client is None:
        return False
    try:
        # document_matches cascade-deletes via FK (on delete cascade), so
        # deleting the documents row is enough.
        resp = client.table("documents").delete().eq("id", report_id).execute()
        return bool(resp.data)
    except Exception:
        logger.exception("Failed to delete documents row for report_id=%s", report_id)
        return False


def _fetch_from_supabase(report_id: str) -> Optional[dict[str, Any]]:
    client = get_client()
    if client is None:
        return None
    try:
        doc_resp = client.table("documents").select("*").eq("id", report_id).maybe_single().execute()
        doc = doc_resp.data if doc_resp else None
        if not doc:
            return None
        matches_resp = (
            client.table("document_matches")
            .select("*")
            .eq("document_id", report_id)
            .execute()
        )
        matches = matches_resp.data or []
        return {
            "report_id": report_id,
            "status": "completed",
            "input": {"type": "pdf" if doc.get("file_name") else "text", "name": doc.get("file_name") or doc.get("title")},
            "user_id": doc.get("user_id"),
            "created_at": doc.get("uploaded_at"),
            "overall_score": doc.get("similarity_score"),
            "document_status": doc.get("status"),
            "matches": matches,
        }
    except Exception:
        logger.exception("Failed to fetch report_id=%s from Supabase", report_id)
        return None


def _list_from_supabase(user_id: Optional[str], is_admin: bool) -> Optional[list[dict[str, Any]]]:
    client = get_client()
    if client is None:
        return None
    try:
        query = client.table("documents").select("*").order("uploaded_at", desc=True)
        if not is_admin:
            query = query.eq("user_id", user_id)
        resp = query.execute()
        return [
            {
                "report_id": d.get("id"),
                "status": "completed",
                "input": {"type": "pdf" if d.get("file_name") else "text", "name": d.get("title")},
                "overall_score": d.get("similarity_score") or 0,
                "created_at": d.get("uploaded_at"),
            }
            for d in (resp.data or [])
        ]
    except Exception:
        logger.exception("Failed to list documents from Supabase")
        return None


def save_report(report: dict[str, Any], *, input_type: str,
                 input_name: str | None = None,
                 user_id: str | None = None) -> str:
    init_report_store()
    report_id = str(uuid.uuid4())
    wrapped = {
        "report_id": report_id,
        "status": "completed",
        "input": {"type": input_type, "name": input_name},
        "user_id": user_id,
        "created_at": _now_iso(),
        **report,
    }
    path = REPORT_DIR / f"{report_id}.json"
    with path.open("w", encoding="utf-8") as f:
        json.dump(wrapped, f, ensure_ascii=False, indent=2)
    with _LOCK:
        _REPORTS[report_id] = wrapped

    _persist_to_supabase(report_id, report, user_id=user_id,
                         input_type=input_type, input_name=input_name)

    return report_id


def get_report(report_id: str) -> dict[str, Any] | None:
    # 1. Fast path: in-memory cache (this process already handled it).
    with _LOCK:
        cached = _REPORTS.get(report_id)
        if cached is not None:
            return deepcopy(cached)

    # 2. Source of truth: Supabase (survives restarts / redeploys where
    #    local disk is ephemeral, e.g. a container redeploy).
    from_supabase = _fetch_from_supabase(report_id)
    if from_supabase is not None:
        with _LOCK:
            _REPORTS[report_id] = from_supabase
        return deepcopy(from_supabase)

    # 3. Last-resort fallback: local JSON file (useful in local dev without
    #    Supabase configured, or if Supabase is briefly unreachable).
    path = REPORT_DIR / f"{report_id}.json"
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as f:
        report = json.load(f)
    with _LOCK:
        _REPORTS[report_id] = report
    return deepcopy(report)


def list_reports(user_id: str | None = None, is_admin: bool = False) -> list[dict[str, Any]]:
    from_supabase = _list_from_supabase(user_id, is_admin)
    if from_supabase is not None:
        return from_supabase

    # Local fallback (no Supabase configured): filter the local JSON store
    # by the wrapped "user_id" field written in save_report, so this still
    # respects per-user scoping in dev.
    init_report_store()
    reports = []
    for path in sorted(REPORT_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            with path.open("r", encoding="utf-8") as f:
                report = json.load(f)
            if not is_admin and user_id is not None and report.get("user_id") not in (None, user_id):
                continue
            reports.append({
                "report_id": report.get("report_id"),
                "status": report.get("status"),
                "input": report.get("input", {}),
                "overall_score": report.get("overall_score", 0),
                "created_at": report.get("created_at"),
            })
        except (OSError, json.JSONDecodeError):
            continue
    return reports


def delete_report(report_id: str) -> bool:
    path = REPORT_DIR / f"{report_id}.json"
    deleted = False
    if path.exists():
        path.unlink()
        deleted = True
    with _LOCK:
        if report_id in _REPORTS:
            del _REPORTS[report_id]
            deleted = True
    if _delete_from_supabase(report_id):
        deleted = True
    return deleted
