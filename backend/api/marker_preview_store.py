"""
marker_preview_store.py
------------------------
In-memory status/result store for the marker-pdf preview conversion,
mirroring job_manager.py's pattern (same non-durability tradeoff — see its
module docstring: an in-flight or completed preview is lost on a process
restart, same as an in-flight check job. This is strictly a nicer-to-have
display layer, not the check result itself, so that's an acceptable
tradeoff here).

Keyed by report_id (not job_id) since a marker preview belongs to a
completed report, and the frontend only ever asks for it once the report
page is open.
"""

from __future__ import annotations

import threading
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Literal

_STORE: dict[str, dict[str, Any]] = {}
_LOCK = threading.Lock()

MarkerStatus = Literal["pending", "ready", "failed"]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def init_marker_preview(report_id: str) -> None:
    """Registers a report as "conversion in progress" the moment the
    background thread is spawned, so an early poll sees "pending" rather
    than a 404/"unavailable" that a naive client might treat as final."""
    with _LOCK:
        _STORE[report_id] = {
            "status": "pending",
            "html": None,
            "docx_ready": False,
            "docx_local_path": None,
            "error": None,
            "updated_at": _now_iso(),
        }


def mark_marker_preview_ready(report_id: str, *, html: str, docx_local_path: str) -> None:
    with _LOCK:
        entry = _STORE.setdefault(report_id, {})
        entry.update(
            status="ready",
            html=html,
            docx_ready=True,
            docx_local_path=docx_local_path,
            error=None,
            updated_at=_now_iso(),
        )


def mark_marker_preview_failed(report_id: str, *, error: str) -> None:
    with _LOCK:
        entry = _STORE.setdefault(report_id, {})
        entry.update(
            status="failed",
            html=None,
            docx_ready=False,
            docx_local_path=None,
            error=error,
            updated_at=_now_iso(),
        )


def get_marker_preview(report_id: str) -> dict[str, Any] | None:
    """Returns a copy without `docx_local_path` (a server-local filesystem
    path — internal only, never meant to reach the client; the docx is
    served through its own endpoint instead)."""
    with _LOCK:
        entry = _STORE.get(report_id)
        if entry is None:
            return None
        public = deepcopy(entry)
    public.pop("docx_local_path", None)
    return public


def has_docx_ready(report_id: str) -> str | None:
    """Returns the local docx path if ready, else None. Internal-only
    accessor for the download endpoint (unlike get_marker_preview, which
    strips this path before returning to the frontend)."""
    with _LOCK:
        entry = _STORE.get(report_id)
        if entry and entry.get("status") == "ready":
            return entry.get("docx_local_path")
        return None
