"""
recheck_store.py
----------------
Supabase reads and writes for Save & re-check (PLAN.md): the stored passages
the editor's block ids refer to, the version a re-check belongs to, and the
document_checks history (supabase/migrations/20261021000000_document_checks.sql).
Only the backend (service role) writes document_checks.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any, Optional

import httpx

from supabase_client import get_client

logger = logging.getLogger(__name__)

# A finished re-check is worth one retry: the GPU work is already done.
_INSERT_ATTEMPTS = 2

_PASSAGE_COLUMNS = "id, text, block_type, level, list_type, page, table_rows, image_url, text_marks"


class RecheckStoreError(RuntimeError):
    pass


def fetch_passages(document_id: str) -> dict[str, dict[str, Any]]:
    """document_passages rows keyed by id, in document order ({} without
    Supabase or on error: the re-check then tells changed blocks apart by text
    alone)."""
    client = get_client()
    if client is None:
        return {}
    try:
        resp = (
            client.table("document_passages").select(_PASSAGE_COLUMNS).eq("document_id", document_id)
            .order("sort_order").execute()
        )
    except Exception:
        logger.exception("Failed to load passages for document_id=%s", document_id)
        return {}
    return {str(row["id"]): row for row in (resp.data or []) if row.get("id") is not None}


def version_belongs_to(version_id: str, document_id: str) -> bool:
    """True when the saved version exists on the server for this document.
    Without Supabase there is nothing to check against."""
    client = get_client()
    if client is None:
        return True
    try:
        resp = (
            client.table("document_versions")
            .select("id")
            .eq("id", version_id)
            .eq("document_id", document_id)
            .maybe_single()
            .execute()
        )
    except Exception:
        logger.exception("Failed to look up version_id=%s", version_id)
        return False
    return bool(resp and resp.data)


def has_stored_result(document_id: str) -> bool:
    """Whether the document has any document_checks row, i.e. its current
    report is already kept there. Raises RecheckStoreError when it can't tell:
    guessing "yes" could let a re-check overwrite the only copy of a result."""
    client = get_client()
    if client is None:
        return True
    try:
        resp = client.table("document_checks").select("id").eq("document_id", document_id).limit(1).execute()
    except Exception as exc:
        logger.exception("Failed to look up checks for document_id=%s", document_id)
        raise RecheckStoreError("Couldn't save the current version, so nothing was changed.") from exc
    return bool(resp.data)


def current_check_result(document_id: str) -> Optional[dict[str, Any]]:
    """The stored report the document shows now: the check its
    documents.current_check_id names (set by re-checks and restores), else
    the newest check. None when it has no checks or they can't be read."""
    client = get_client()
    if client is None:
        return None
    try:
        doc = client.table("documents").select("current_check_id").eq("id", document_id).maybe_single().execute()
        current = ((doc.data if doc else None) or {}).get("current_check_id")
        query = client.table("document_checks").select("result").eq("document_id", document_id)
        query = query.eq("id", current) if current else query.order("created_at", desc=True).limit(1)
        resp = query.execute()
    except Exception:
        logger.exception("Failed to load the current check for document_id=%s", document_id)
        return None
    rows = resp.data or []
    result = rows[0].get("result") if rows else None
    return result if isinstance(result, dict) and result.get("matches") is not None else None


def insert_check(*, document_id: str, version_id: Optional[str], kind: str, balance_source: Optional[str],
                 changed_ratio: float, similarity_score: float, baseline_text: str,
                 result: dict[str, Any], ai_score: Optional[float] = None,
                 previous_score: Optional[float] = None, previous_ai_score: Optional[float] = None,
                 previous_text: Optional[str] = None) -> Optional[str]:
    """Record a check result and return its id: a finished re-check, or with
    kind "upload" the report a document had before its first re-check. Raises
    RecheckStoreError on failure: an unrecorded free re-check would not count
    against the free allowance, and an unrecorded upload could never be
    restored."""
    client = get_client()
    if client is None:
        return None
    row = {
        # Set here, not by the database, so a retry after a dropped connection
        # can't add the re-check twice (the first attempt may have landed).
        "id": str(uuid.uuid4()),
        "document_id": document_id,
        "version_id": version_id,
        "kind": kind,
        "balance_source": balance_source,
        "changed_ratio": round(min(1.0, max(0.0, changed_ratio)), 4),
        "similarity_score": similarity_score,
        "baseline_text": baseline_text,
        "result": result,
        "ai_score": ai_score,
        "previous_score": previous_score,
        "previous_ai_score": previous_ai_score,
        "previous_text": previous_text,
    }
    for attempt in range(_INSERT_ATTEMPTS):
        try:
            client.table("document_checks").upsert(row, on_conflict="id", ignore_duplicates=True).execute()
            return row["id"]
        except httpx.TransportError as exc:
            if attempt + 1 == _INSERT_ATTEMPTS:
                logger.exception("Failed to record re-check for document_id=%s", document_id)
                raise RecheckStoreError("Couldn't save the re-check.") from exc
            logger.warning("Retrying the re-check record for document_id=%s", document_id, exc_info=True)
        except Exception as exc:
            logger.exception("Failed to record re-check for document_id=%s", document_id)
            raise RecheckStoreError("Couldn't save the re-check.") from exc


def fetch_check_result(check_id: str, document_id: str) -> Optional[dict[str, Any]]:
    """One re-check's stored report, for restoring it from Version History."""
    client = get_client()
    if client is None:
        return None
    try:
        resp = (
            client.table("document_checks")
            .select("result")
            .eq("id", check_id)
            .eq("document_id", document_id)
            .maybe_single()
            .execute()
        )
    except Exception:
        logger.exception("Failed to load check_id=%s", check_id)
        raise RecheckStoreError("Couldn't load that check.")
    result = ((resp.data if resp else None) or {}).get("result")
    return result if isinstance(result, dict) and result.get("matches") is not None else None
