"""
What the backend does for an admin goes into public.admin_action_log
(supabase/migrations/20261108000000_admin_action_log.sql), the log shown in
the admin portal under Logs > Admin actions.

Changes an admin makes straight from the portal are logged by database
triggers. The backend works with the service role, which those triggers
can't attribute to anyone, so every admin endpoint here records its action
itself with record_admin_action(), naming the admin.

Recording never fails the action: errors are logged and swallowed.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any, Optional

from log_setup import current_request
from supabase_client import get_client

logger = logging.getLogger("api.admin_log")


def record_admin_action(
    admin_id: str,
    action: str,
    *,
    target_table: Optional[str] = None,
    target_id: Optional[str] = None,
    target_user_id: Optional[str] = None,
    summary: Optional[str] = None,
    changes: Optional[dict[str, Any]] = None,
    metadata: Optional[dict[str, Any]] = None,
) -> None:
    meta = dict(metadata or {})
    ctx = current_request()
    if ctx and ctx.get("id"):
        meta.setdefault("request_id", ctx["id"])  # matches [r:<id>] in the server log
    logger.info("Admin %s: %s %s%s", admin_id[:8], action, target_table or "",
                f" {target_id}" if target_id else "")
    client = get_client()
    if client is None:
        return
    try:
        client.rpc("log_admin_action", {
            "p_actor_id": admin_id,
            "p_source": "backend",
            "p_action": action,
            "p_target_table": target_table,
            "p_target_id": target_id,
            "p_target_user_id": target_user_id,
            "p_summary": summary,
            "p_changes": changes or {},
            "p_metadata": meta,
        }).execute()
    except Exception:
        logger.exception("Couldn't record admin action %s by %s", action, admin_id[:8])


# Reading another user's report: logged once per admin, path and 10 minutes,
# since one opened report makes several requests (report, PDF, preview...).
_VIEW_WINDOW_SECONDS = 600
_recent_views: dict[tuple[str, str], float] = {}
_views_lock = threading.Lock()


def record_admin_view(admin_id: str, owner_id: Optional[str]) -> None:
    ctx = current_request() or {}
    path = ctx.get("path") or "?"
    key = (admin_id, path)
    now = time.monotonic()
    with _views_lock:
        if now - _recent_views.get(key, -_VIEW_WINDOW_SECONDS) < _VIEW_WINDOW_SECONDS:
            return
        _recent_views[key] = now
        if len(_recent_views) > 5000:  # keep it bounded
            for k in [k for k, t in _recent_views.items() if now - t >= _VIEW_WINDOW_SECONDS]:
                del _recent_views[k]
    parts = path.strip("/").split("/")
    # /api/reports/<id>/..., /api/jobs/<id>
    target_table = {"reports": "documents", "jobs": "jobs"}.get(parts[1] if len(parts) > 1 else "", None)
    record_admin_action(
        admin_id, "user_data.viewed",
        target_table=target_table,
        target_id=parts[2] if len(parts) > 2 else None,
        target_user_id=owner_id,
        metadata={"method": ctx.get("method"), "path": path},
    )
