"""
Admin Logs screen (apps/admin/src/screens/Logs): what the API is doing, from
the admin portal, without a shell on the server.

    GET  /api/admin/logs                  the live log, kept in memory (log_setup.LOG_BUFFER)
    GET  /api/admin/logs/files            the log files on the server
    GET  /api/admin/logs/files/{name}     the end of one of them
    GET  /api/admin/server                process, machine, GPU and running checks
    POST /api/admin/server/actions/{name} one of a fixed list of actions

Everything needs an admin session that passed an authenticator code. There
is deliberately no way to run arbitrary commands: each action below is a
specific function, and each use is logged and written to audit_log.

Log files are a fixed list read from LOG_DIR (default backend/logs, where
supervisord writes them, docs/SERVER_OPERATIONS.md); a name outside the list
is a 404, so no path from the request ever reaches the filesystem.
"""
from __future__ import annotations

import logging
import math
import os
import platform
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

import gpu_queue
from auth import AuthedUser, verify_supabase_jwt
from job_manager import active_count, job_overview
from log_setup import (LEVELS, LOG_BUFFER, PROCESS_STARTED, current_level, memory_numbers, set_level,
                       uptime_text)
from supabase_client import get_client

logger = logging.getLogger("api.admin_ops")
router = APIRouter()

BACKEND_DIR = Path(__file__).resolve().parent.parent
LOG_DIR = Path(os.getenv("LOG_DIR", str(BACKEND_DIR / "logs")))
SUPERVISOR_CONF = Path(os.getenv("SUPERVISOR_CONF", str(BACKEND_DIR / "supervisord.conf")))
SUPERVISORCTL = Path(os.getenv("SUPERVISORCTL", str(BACKEND_DIR / ".venv" / "bin" / "supervisorctl")))
API_PROGRAM = os.getenv("SUPERVISOR_API_PROGRAM", "etymos-api")

# name -> (file in LOG_DIR, what it is). The order is the order shown.
LOG_FILES: dict[str, tuple[str, str]] = {
    "api": ("api.err.log", "API: everything it logged, across restarts"),
    "api-out": ("api.out.log", "API: anything written straight to stdout"),
    "deploy": ("deploy.log", "Auto-deploy: pulls, test runs, restarts, rollbacks"),
    "tests": ("deploy_tests.log", "The last backend test run before a deploy"),
    "tunnel": ("cloudflared.err.log", "Cloudflare tunnel"),
    "supervisor": ("supervisord.log", "Supervisor: process starts, exits and crashes"),
}
# The most read from the end of a file in one request.
TAIL_BYTES = 4 * 1024 * 1024


def require_admin(user: AuthedUser = Depends(verify_supabase_jwt)) -> AuthedUser:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admins only.")
    return user


# --- Live log ---------------------------------------------------------------------------

@router.get("/api/admin/logs")
def read_live_log(
    after: int = Query(0, ge=0),
    limit: int = Query(500, ge=1, le=2000),
    level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "DEBUG",
    q: Optional[str] = Query(None, max_length=200),
    job: Optional[str] = Query(None, max_length=40),
    request: Optional[str] = Query(None, max_length=16),
    user_id: Optional[str] = Query(None, max_length=40),
    _: AuthedUser = Depends(require_admin),
):
    """Records after `after` (a seq from a previous answer) that match the
    filters. `after=0` gives the newest `limit`."""
    result = LOG_BUFFER.query(after=after, limit=limit, min_level=getattr(logging, level),
                              text=(q or "").strip() or None, job=(job or "").strip() or None,
                              request=(request or "").strip() or None, user=(user_id or "").strip() or None)
    return {
        **result,
        "capacity": LOG_BUFFER.capacity,
        "level": current_level(),
        "started_at": _iso(PROCESS_STARTED),
        "pid": os.getpid(),
    }


# --- Log files --------------------------------------------------------------------------

def _file_info(name: str) -> dict[str, Any]:
    filename, description = LOG_FILES[name]
    path = LOG_DIR / filename
    try:
        st = path.stat()
        return {"name": name, "file": filename, "description": description, "exists": True,
                "size_bytes": st.st_size, "modified_at": _iso(st.st_mtime)}
    except OSError:
        return {"name": name, "file": filename, "description": description, "exists": False,
                "size_bytes": 0, "modified_at": None}


@router.get("/api/admin/logs/files")
def list_log_files(_: AuthedUser = Depends(require_admin)):
    return {"dir": str(LOG_DIR), "files": [_file_info(name) for name in LOG_FILES]}


def tail_lines(path: Path, lines: int, text: Optional[str] = None) -> tuple[list[str], bool]:
    """The last `lines` lines of `path` (containing `text`, if given), reading
    at most TAIL_BYTES from the end. The bool says whether the file goes back
    further than what was read."""
    with path.open("rb") as f:
        f.seek(0, os.SEEK_END)
        size = f.tell()
        start = max(0, size - TAIL_BYTES)
        f.seek(start)
        data = f.read()
    rows = data.decode("utf-8", errors="replace").splitlines()
    if start > 0 and rows:
        rows = rows[1:]  # the first line was cut in the middle
    if text:
        needle = text.lower()
        rows = [r for r in rows if needle in r.lower()]
    return rows[-lines:], start > 0 or len(rows) > lines


@router.get("/api/admin/logs/files/{name}")
def read_log_file(name: str, lines: int = Query(500, ge=1, le=5000),
                  q: Optional[str] = Query(None, max_length=200),
                  _: AuthedUser = Depends(require_admin)):
    if name not in LOG_FILES:
        raise HTTPException(status_code=404, detail="No such log file.")
    info = _file_info(name)
    if not info["exists"]:
        return {**info, "lines": [], "more": False}
    try:
        rows, more = tail_lines(LOG_DIR / LOG_FILES[name][0], lines, (q or "").strip() or None)
    except OSError as exc:
        logger.warning("Couldn't read log file %s: %s", name, exc)
        raise HTTPException(status_code=500, detail=f"Couldn't read the file: {exc.strerror or exc}")
    return {**info, "lines": rows, "more": more}


# --- Server status ----------------------------------------------------------------------

_COMMIT: Optional[str] = None


def _commit() -> str:
    global _COMMIT
    if _COMMIT is None:
        try:
            out = subprocess.run(["git", "log", "-1", "--format=%h %s"], cwd=BACKEND_DIR,
                                 capture_output=True, text=True, timeout=5).stdout.strip()
            _COMMIT = out or "?"
        except Exception:
            _COMMIT = "?"
    return _COMMIT


def _gpu() -> dict[str, Any]:
    info: dict[str, Any] = {"available": False, "queue": gpu_queue.state(), "models": []}
    gpu_models = sys.modules.get("gpu_models")
    if gpu_models is not None:
        try:
            info["models"] = gpu_models.status()
            budget = gpu_models.budget_gb()
            info["budget_gb"] = round(budget, 2) if math.isfinite(budget) else None
        except Exception:
            logger.debug("gpu_models.status() failed", exc_info=True)
    torch = sys.modules.get("torch")
    if torch is None:
        return info
    try:
        if torch.cuda.is_available():
            gb = 1024 ** 3
            props = torch.cuda.get_device_properties(0)
            info.update(available=True, name=props.name, total_gb=round(props.total_memory / gb, 2))
            if torch.cuda.is_initialized():
                free, total = torch.cuda.mem_get_info()
                info.update(free_gb=round(free / gb, 2),
                            allocated_gb=round(torch.cuda.memory_allocated() / gb, 2),
                            reserved_gb=round(torch.cuda.memory_reserved() / gb, 2),
                            peak_gb=round(torch.cuda.max_memory_allocated() / gb, 2))
    except Exception as exc:
        info["error"] = str(exc)
    return info


def _disk(path: Path) -> Optional[dict[str, float]]:
    try:
        usage = shutil.disk_usage(path)
    except OSError:
        return None
    gb = 1024 ** 3
    return {"path": str(path), "total_gb": round(usage.total / gb, 1), "free_gb": round(usage.free / gb, 1),
            "used_percent": round(usage.used / usage.total * 100, 1) if usage.total else 0}


def server_status() -> dict[str, Any]:
    threads = threading.enumerate()
    names = {t.name for t in threads}
    try:
        load = [round(x, 2) for x in os.getloadavg()]
    except OSError:
        load = None
    return {
        "checked_at": _iso(time.time()),
        "process": {
            "pid": os.getpid(),
            "started_at": _iso(PROCESS_STARTED),
            "uptime": uptime_text(),
            "uptime_seconds": round(time.time() - PROCESS_STARTED),
            "commit": _commit(),
            "python": sys.version.split()[0],
            "threads": len(threads),
            "log_level": current_level(),
            "log_buffer": {"capacity": LOG_BUFFER.capacity, "last_seq": LOG_BUFFER.last_seq()},
            "supervised": _supervised(),
        },
        "host": {
            "name": socket.gethostname(),
            "platform": platform.platform(terse=True),
            "cpus": os.cpu_count(),
            "load": load,
            "disk": _disk(BACKEND_DIR),
        },
        "memory": memory_numbers(),
        "gpu": _gpu(),
        "background": {
            "notifications": "notifications" in names,
            "support_inbox": "support-inbox" in names,
        },
        "jobs": job_overview(),
    }


@router.get("/api/admin/server")
def read_server_status(_: AuthedUser = Depends(require_admin)):
    return server_status()


# --- Actions ----------------------------------------------------------------------------

class ActionIn(BaseModel):
    level: Optional[Literal["DEBUG", "INFO", "WARNING", "ERROR"]] = None
    force: bool = False


def _supervised() -> bool:
    return SUPERVISORCTL.exists() and SUPERVISOR_CONF.exists()


def _audit(admin: AuthedUser, action: str, metadata: dict[str, Any]) -> None:
    client = get_client()
    if client is None:
        return
    try:
        client.table("audit_log").insert(
            {"actor_id": admin.user_id, "action": f"server.{action}", "metadata": metadata}).execute()
    except Exception:
        logger.exception("Couldn't write the audit_log row for server action %s", action)


def dump_threads() -> int:
    """Every thread's current stack, as one WARNING line each: what a stuck
    check is waiting on."""
    frames = sys._current_frames()
    threads = threading.enumerate()
    for thread in threads:
        frame = frames.get(thread.ident) if thread.ident is not None else None
        stack = "".join(traceback.format_stack(frame)).rstrip() if frame else "(no frame)"
        logger.warning("Thread %r (daemon=%s, id=%s) stack:\n%s", thread.name, thread.daemon, thread.ident, stack)
    return len(threads)


def _restart_api() -> None:
    # A separate session, so it survives supervisord stopping this process;
    # the short wait lets this request's answer reach the browser first.
    subprocess.Popen(
        ["/bin/sh", "-c", f'sleep 2; exec "{SUPERVISORCTL}" -c "{SUPERVISOR_CONF}" restart {API_PROGRAM}'],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True, cwd=BACKEND_DIR,
    )


ACTIONS = ("log-level", "dump-threads", "free-gpu", "run-notifications", "poll-support-inbox", "restart-api")


@router.post("/api/admin/server/actions/{action}")
async def run_action(action: str, body: ActionIn | None = None, admin: AuthedUser = Depends(require_admin)):
    if action not in ACTIONS:
        raise HTTPException(status_code=404, detail="No such action.")
    body = body or ActionIn()
    who = admin.user_id[:8]
    logger.warning("Admin %s ran server action %r%s", who, action,
                   f" level={body.level}" if body.level else (" (forced)" if body.force else ""))
    started = time.perf_counter()

    if action == "log-level":
        if not body.level:
            raise HTTPException(status_code=422, detail="Pick a level.")
        before = current_level()
        after = set_level(body.level)
        logger.warning("Log level changed %s -> %s by admin %s (until the API restarts)", before, after, who)
        result: dict[str, Any] = {"level": after, "previous": before}

    elif action == "dump-threads":
        result = {"threads": await run_in_threadpool(dump_threads)}

    elif action == "free-gpu":
        gpu_models = sys.modules.get("gpu_models")
        if gpu_models is None:
            raise HTTPException(status_code=409, detail="No models are loaded in this process.")
        freed = await run_in_threadpool(gpu_models.free_idle)
        logger.warning("Freed idle GPU models: %s", ", ".join(freed) or "none (all in use or none loaded)")
        result = {"freed": freed}

    elif action == "run-notifications":
        import notifications
        counts = await run_in_threadpool(notifications.run_scheduled_pass)
        logger.warning("Notification pass run by hand: %s", counts or "nothing to do (or email not configured)")
        result = {"counts": counts}

    elif action == "poll-support-inbox":
        import support_inbound
        if not support_inbound.poller_enabled():
            raise HTTPException(status_code=409, detail="Inbox polling is off or the support mailbox isn't set up.")
        counts = await run_in_threadpool(support_inbound.poll_once)
        logger.warning("Support inbox polled by hand: %s", counts or "no new email")
        result = {"counts": counts}

    else:  # restart-api
        if not _supervised():
            raise HTTPException(status_code=409, detail="This API isn't running under supervisor, so it can't restart itself.")
        running = active_count()
        if running and not body.force:
            raise HTTPException(status_code=409, detail=f"{running} check(s) are running and would be lost.")
        logger.warning("API restart requested by admin %s (%d check(s) running)", who, running)
        _restart_api()
        result = {"restarting": True, "lost_checks": running}

    took = round((time.perf_counter() - started) * 1000)
    await run_in_threadpool(_audit, admin, action, {**{k: v for k, v in result.items() if k != "counts"},
                                                    "level": body.level, "force": body.force, "ms": took})
    return {"action": action, "ms": took, **result}


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat()
