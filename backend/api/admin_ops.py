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
specific function, and each use is logged and written to admin_action_log
(admin_log.py).

Log files are a fixed list read from LOG_DIR (default backend/logs, where
supervisord writes them, docs/SERVER_OPERATIONS.md); a name outside the list
is a 404, so no path from the request ever reaches the filesystem.
"""
from __future__ import annotations

import asyncio
import inspect
import logging
import math
import os
import platform
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

import anyio
from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

import gpu_queue
from auth import AuthedUser, verify_jwt_token, verify_supabase_jwt
from job_manager import active_count, job_overview
from local_ops_auth import authenticate_local_ops_request, authenticate_local_ops_ws
from log_setup import (LEVELS, LOG_BUFFER, PROCESS_STARTED, current_level, memory_numbers, set_level,
                       uptime_text)
from admin_log import record_admin_action

logger = logging.getLogger("api.admin_ops")
router = APIRouter()

BACKEND_DIR = Path(__file__).resolve().parent.parent
LOG_DIR = Path(os.getenv("LOG_DIR", str(BACKEND_DIR / "logs")))
SUPERVISOR_CONF = Path(os.getenv("SUPERVISOR_CONF", str(BACKEND_DIR / "supervisord.conf")))


def _default_supervisorctl() -> Path:
    env = os.getenv("SUPERVISORCTL")
    if env:
        return Path(env)
    venv_bin = BACKEND_DIR / ".venv" / "bin" / "supervisorctl"
    if venv_bin.exists():
        return venv_bin
    on_path = shutil.which("supervisorctl")
    return Path(on_path) if on_path else venv_bin


SUPERVISORCTL = _default_supervisorctl()
API_PROGRAM = os.getenv("SUPERVISOR_API_PROGRAM", "etymos-api")
MANAGED_SERVICES = ("etymos-api", "cloudflared", "etymos-deploy")
_LOCAL_BEARER = HTTPBearer(auto_error=False)

# name -> (file in LOG_DIR, what it is). The order is the order shown.
LOG_FILES: dict[str, tuple[str, str]] = {
    "api": ("api.err.log", "API: everything it logged, across restarts"),
    "api-out": ("api.out.log", "API: anything written straight to stdout"),
    "deploy": ("deploy.log", "Auto-deploy: pulls, test runs, restarts, rollbacks"),
    "tests": ("deploy_tests.log", "The last backend test run before a deploy"),
    "tunnel": ("cloudflared.err.log", "Cloudflare tunnel"),
    "supervisor": ("supervisord.log", "Supervisor: process starts, exits and crashes"),
    "autostart": ("autostart.log", "Auto-start: host boot recovery and supervisor launches"),
}
# The most read from the end of a file in one request.
TAIL_BYTES = 4 * 1024 * 1024


async def require_admin(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_LOCAL_BEARER),
) -> AuthedUser:
    local_user = authenticate_local_ops_request(request)
    if local_user is not None:
        return local_user
    override = request.app.dependency_overrides.get(verify_supabase_jwt)
    if override is not None:
        user = override()
        if inspect.isawaitable(user):
            user = await user
    else:
        user = await verify_supabase_jwt(request, credentials)
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


_SUPERVISOR_STATUS_RE = re.compile(r"^([A-Za-z0-9_.:-]+)\s+([A-Z]+)(?:\s+(.*))?$")
_SUPERVISOR_PID_RE = re.compile(r"\bpid\s+(\d+)\b")
_SUPERVISOR_UPTIME_RE = re.compile(r"\buptime\s+([0-9:,\s\w-]+?)$")


def _supervisor_services() -> list[dict[str, Any]]:
    """Return managed supervisor program statuses when supervisor is available."""
    if not _supervised():
        return []
    try:
        proc = subprocess.run(
            [str(SUPERVISORCTL), "-c", str(SUPERVISOR_CONF), "status"],
            capture_output=True,
            text=True,
            timeout=2,
        )
        raw = proc.stdout or proc.stderr or ""
    except Exception:
        return []
    services: list[dict[str, Any]] = []
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        match = _SUPERVISOR_STATUS_RE.match(stripped)
        if not match:
            continue
        name, state, detail = match.group(1), match.group(2), (match.group(3) or "").strip()
        pid_m = _SUPERVISOR_PID_RE.search(detail)
        uptime_m = _SUPERVISOR_UPTIME_RE.search(detail)
        services.append({
            "name": name,
            "state": state,
            "pid": int(pid_m.group(1)) if pid_m else None,
            "uptime": uptime_m.group(1).strip() if uptime_m else None,
            "detail": detail,
        })
    return services


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
        "services": _supervisor_services(),
        "jobs": job_overview(),
    }


@router.get("/api/admin/server")
def read_server_status(_: AuthedUser = Depends(require_admin)):
    return server_status()


# --- Actions ----------------------------------------------------------------------------

class ActionIn(BaseModel):
    level: Optional[Literal["DEBUG", "INFO", "WARNING", "ERROR"]] = None
    force: bool = False
    service: Optional[Literal["etymos-api", "cloudflared", "etymos-deploy"]] = None


def _supervised() -> bool:
    return SUPERVISORCTL.exists() and SUPERVISOR_CONF.exists()


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


def _shutdown_api(supervised: bool) -> None:
    # Stop only the API service cleanly after letting the response flush:
    # under supervisord, `supervisorctl stop` prevents autorestart=true from
    # respawning it; standalone processes exit cleanly via SIGTERM.
    if supervised:
        subprocess.Popen(
            ["/bin/sh", "-c", f'sleep 2; exec "{SUPERVISORCTL}" -c "{SUPERVISOR_CONF}" stop {API_PROGRAM}'],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True, cwd=BACKEND_DIR,
        )
    else:
        timer = threading.Timer(2.0, lambda: os.kill(os.getpid(), signal.SIGTERM))
        timer.daemon = True
        timer.start()


def _deferred_service_action(verb: str, service: str) -> None:
    """Run supervisorctl after a 2s delay so HTTP responses flush before api/tunnel drops."""
    if verb not in ("restart", "stop", "start") or service not in MANAGED_SERVICES:
        raise ValueError("Unsupported deferred supervisor service action.")
    subprocess.Popen(
        ["/bin/sh", "-c", f'sleep 2; exec "{SUPERVISORCTL}" -c "{SUPERVISOR_CONF}" {verb} {service}'],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True, cwd=BACKEND_DIR,
    )


def _run_service_action(verb: str, service: str) -> str:
    if verb not in ("restart", "stop", "start") or service not in MANAGED_SERVICES:
        raise ValueError("Unsupported supervisor service action.")
    proc = subprocess.run(
        [str(SUPERVISORCTL), "-c", str(SUPERVISOR_CONF), verb, service],
        capture_output=True, text=True, timeout=10, cwd=BACKEND_DIR,
    )
    out = (proc.stdout or proc.stderr or "").strip()
    if proc.returncode != 0:
        raise RuntimeError(out or f"{service}: {verb} exited with {proc.returncode}")
    return out or f"{service}: {verb} ok"


ACTIONS = (
    "log-level",
    "dump-threads",
    "free-gpu",
    "run-notifications",
    "poll-support-inbox",
    "restart-api",
    "shutdown-api",
    "restart-service",
    "stop-service",
    "start-service",
)


@router.post("/api/admin/server/actions/{action}")
async def run_action(action: str, body: ActionIn | None = None, admin: AuthedUser = Depends(require_admin)):
    if action not in ACTIONS:
        raise HTTPException(status_code=404, detail="No such action.")
    body = body or ActionIn()
    who = admin.user_id[:8]
    logger.warning("Admin %s ran server action %r%s", who, action,
                   f" level={body.level}" if body.level else (" (forced)" if body.force else ""))
    started = time.perf_counter()
    deferred_lifecycle: Optional[tuple[str, bool]] = None

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

    elif action == "restart-api":
        if not _supervised():
            raise HTTPException(status_code=409, detail="This API isn't running under supervisor, so it can't restart itself.")
        running = active_count()
        if running and not body.force:
            raise HTTPException(status_code=409, detail=f"{running} check(s) are running and would be lost.")
        logger.warning("API restart requested by admin %s (%d check(s) running)", who, running)
        deferred_lifecycle = ("restart", True)
        result = {"restarting": True, "lost_checks": running}

    elif action in ("restart-service", "stop-service", "start-service"):
        if not body.service:
            raise HTTPException(status_code=422, detail="Pick a managed service.")
        if not _supervised():
            raise HTTPException(status_code=409, detail="Supervisor is not configured on this server.")
        verb = action.removesuffix("-service")
        service = body.service
        running = active_count() if (service == "etymos-api" and verb in ("restart", "stop")) else 0
        if running and not body.force:
            raise HTTPException(status_code=409, detail=f"{running} check(s) are running and would be lost.")
        logger.warning("Service action %s on %s requested by admin %s (lost_checks=%d)", verb, service, who, running)
        if service in ("etymos-api", "cloudflared") and verb in ("restart", "stop"):
            deferred_lifecycle = (f"service:{verb}:{service}", True)
            result = {"service": service, "verb": verb, "deferred": True, "lost_checks": running}
        else:
            try:
                out = await run_in_threadpool(_run_service_action, verb, service)
            except Exception as exc:
                raise HTTPException(status_code=500, detail=str(exc))
            result = {"service": service, "verb": verb, "output": out, "lost_checks": running}

    else:  # shutdown-api
        running = active_count()
        if running and not body.force:
            raise HTTPException(status_code=409, detail=f"{running} check(s) are running and would be lost.")
        supervised = _supervised()
        logger.warning("API shutdown requested by admin %s (%d check(s) running, supervised=%s)", who, running, supervised)
        deferred_lifecycle = ("shutdown", supervised)
        result = {"shutting_down": True, "lost_checks": running, "supervised": supervised}

    took = round((time.perf_counter() - started) * 1000)
    await run_in_threadpool(
        lambda: record_admin_action(
            admin.user_id, f"server.{action.replace('-', '_')}", target_table="server",
            target_id=body.service,
            metadata={**result, "level": body.level, "force": body.force, "ms": took}))
    if deferred_lifecycle is not None:
        kind, supervised_flag = deferred_lifecycle
        if kind == "restart":
            _restart_api()
        elif kind == "shutdown":
            _shutdown_api(supervised_flag)
        elif kind.startswith("service:"):
            _, verb, svc = kind.split(":", 2)
            _deferred_service_action(verb, svc)
    return {"action": action, "ms": took, **result}


# --- WebSocket streams ------------------------------------------------------------------

WS_AUTH_TIMEOUT_SECONDS = 10.0
WS_KEEPALIVE_SECONDS = 25.0
WS_BATCH_LIMIT = 200
SERVER_WS_INTERVAL_SECONDS = max(1.0, float(os.getenv("ADMIN_SERVER_WS_INTERVAL", "5.0") or 5.0))
WS_CLOSE_UNAUTHORIZED = 4401
WS_CLOSE_FORBIDDEN = 4403
WS_CLOSE_TIMEOUT = 4408


def _authenticate_ws_token(token: str) -> tuple[AuthedUser, float]:
    user, expires_at = verify_jwt_token(token)
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admins only.")
    return user, expires_at


async def _ws_send_error_and_close(websocket: WebSocket, code: int, err_code: str, detail: str) -> None:
    try:
        await websocket.send_json({"type": "error", "code": err_code, "detail": detail})
    except Exception:
        pass
    try:
        await websocket.close(code=code)
    except Exception:
        pass


async def _ws_handshake_auth(websocket: WebSocket) -> Optional[tuple[AuthedUser, float, dict[str, Any]]]:
    try:
        await websocket.accept()
    except (WebSocketDisconnect, RuntimeError):
        return None
    try:
        msg = await asyncio.wait_for(websocket.receive_json(), timeout=WS_AUTH_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        await _ws_send_error_and_close(websocket, WS_CLOSE_TIMEOUT, "timeout", "Authentication timed out.")
        return None
    except WebSocketDisconnect:
        return None
    except Exception:
        await _ws_send_error_and_close(websocket, WS_CLOSE_UNAUTHORIZED, "bad_request", "Invalid auth frame.")
        return None

    if not isinstance(msg, dict) or msg.get("type") != "auth":
        await _ws_send_error_and_close(websocket, WS_CLOSE_UNAUTHORIZED, "bad_request", "Expected auth frame.")
        return None

    if isinstance(msg.get("local_token"), str):
        try:
            user = await run_in_threadpool(authenticate_local_ops_ws, websocket, msg["local_token"])
            if user is None:
                raise HTTPException(status_code=401, detail="Invalid local ops token.")
            expires_at = time.time() + 86400 * 365
        except HTTPException as exc:
            close_code = WS_CLOSE_FORBIDDEN if exc.status_code == 403 else WS_CLOSE_UNAUTHORIZED
            err_code = "forbidden" if exc.status_code == 403 else "unauthorized"
            await _ws_send_error_and_close(websocket, close_code, err_code, str(exc.detail))
            return None
    elif isinstance(msg.get("token"), str):
        try:
            user, expires_at = await run_in_threadpool(_authenticate_ws_token, msg["token"])
        except HTTPException as exc:
            close_code = WS_CLOSE_FORBIDDEN if exc.status_code == 403 else WS_CLOSE_UNAUTHORIZED
            err_code = "forbidden" if exc.status_code == 403 else "unauthorized"
            await _ws_send_error_and_close(websocket, close_code, err_code, str(exc.detail))
            return None
    else:
        await _ws_send_error_and_close(websocket, WS_CLOSE_UNAUTHORIZED, "bad_request", "Expected auth frame.")
        return None

    try:
        await websocket.send_json({"type": "auth_ok", "pid": os.getpid(), "started_at": _iso(PROCESS_STARTED)})
    except (WebSocketDisconnect, RuntimeError):
        return None
    return user, expires_at, msg


def _parse_log_filters(msg: dict[str, Any]) -> tuple[int, int, dict[str, Any]]:
    raw_after = msg.get("after", 0)
    raw_limit = msg.get("limit", 500)
    try:
        after = max(0, int(raw_after))
    except (TypeError, ValueError):
        after = 0
    try:
        limit = min(2000, max(1, int(raw_limit)))
    except (TypeError, ValueError):
        limit = 500

    raw = msg.get("filters") if isinstance(msg.get("filters"), dict) else {}
    raw_level = str(raw.get("level") or "DEBUG").strip().upper()
    if raw_level not in LEVELS:
        raw_level = "DEBUG"

    def _clean(key: str, max_len: int) -> Optional[str]:
        val = raw.get(key)
        if not isinstance(val, str):
            return None
        trimmed = val.strip()[:max_len]
        return trimmed or None

    user_val = _clean("user_id", 40) or _clean("userId", 40)
    return after, limit, {
        "min_level": getattr(logging, raw_level),
        "text": _clean("q", 200),
        "job": _clean("job", 40),
        "request": _clean("request", 16),
        "user": user_val,
    }


def _snapshot_payload(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "snapshot",
        **result,
        "capacity": LOG_BUFFER.capacity,
        "level": current_level(),
        "started_at": _iso(PROCESS_STARTED),
        "pid": os.getpid(),
    }


@router.websocket("/api/admin/logs/ws")
async def stream_live_logs(websocket: WebSocket):
    auth_info = await _ws_handshake_auth(websocket)
    if auth_info is None:
        return
    _, expires_at, first_msg = auth_info

    after, limit, filters = _parse_log_filters(first_msg)
    sub = LOG_BUFFER.subscribe(asyncio.get_running_loop())
    state = {"expires_at": expires_at, "filters": filters, "limit": limit, "sent_seq": after, "paused": False}
    send_lock = asyncio.Lock()

    try:
        # Subscribe BEFORE querying so lines emitted during snapshot serialization remain queued
        # and deduplicated by `seq > sent_seq`.
        initial = LOG_BUFFER.query(after=after, limit=limit, **filters)
        state["sent_seq"] = max(after, initial["last_seq"])
        async with send_lock:
            await websocket.send_json(_snapshot_payload(initial))

        async with anyio.create_task_group() as tg:
            async def _reader() -> None:
                try:
                    while True:
                        msg = await websocket.receive_json()
                        if not isinstance(msg, dict):
                            continue
                        mtype = msg.get("type")
                        if mtype == "ping":
                            async with send_lock:
                                await websocket.send_json({"type": "pong"})
                        elif mtype == "pong":
                            continue
                        elif mtype == "pause":
                            state["paused"] = True
                        elif mtype in ("subscribe", "resume"):
                            if mtype == "subscribe":
                                new_after, new_limit, new_filters = _parse_log_filters(msg)
                                state["limit"] = new_limit
                                state["filters"] = new_filters
                            else:
                                try:
                                    new_after = max(0, int(msg.get("after", state["sent_seq"])))
                                except (TypeError, ValueError):
                                    new_after = state["sent_seq"]
                            state["paused"] = False
                            # Drain stale queued entries before emitting fresh snapshot.
                            while not sub.queue.empty():
                                try:
                                    sub.queue.get_nowait()
                                except asyncio.QueueEmpty:
                                    break
                            sub.dropped = False
                            snap = LOG_BUFFER.query(after=new_after, limit=state["limit"], **state["filters"])
                            state["sent_seq"] = max(new_after, snap["last_seq"])
                            async with send_lock:
                                await websocket.send_json(_snapshot_payload(snap))
                        elif mtype == "refresh_auth":
                            token = msg.get("token")
                            if not isinstance(token, str):
                                await _ws_send_error_and_close(websocket, WS_CLOSE_UNAUTHORIZED, "unauthorized", "Invalid token.")
                                return
                            try:
                                _, next_exp = await run_in_threadpool(_authenticate_ws_token, token)
                                state["expires_at"] = next_exp
                            except HTTPException as exc:
                                code = WS_CLOSE_FORBIDDEN if exc.status_code == 403 else WS_CLOSE_UNAUTHORIZED
                                err_code = "forbidden" if exc.status_code == 403 else "unauthorized"
                                await _ws_send_error_and_close(websocket, code, err_code, str(exc.detail))
                                return
                except WebSocketDisconnect:
                    pass
                finally:
                    tg.cancel_scope.cancel()

            async def _writer() -> None:
                last_ping = time.monotonic()
                try:
                    while True:
                        remaining = state["expires_at"] - time.time()
                        if remaining <= 0:
                            async with send_lock:
                                await _ws_send_error_and_close(websocket, WS_CLOSE_UNAUTHORIZED, "unauthorized", "Token has expired.")
                            return

                        wait_for = min(WS_KEEPALIVE_SECONDS, max(0.05, remaining))
                        try:
                            first_row = await asyncio.wait_for(sub.queue.get(), timeout=wait_for)
                        except asyncio.TimeoutError:
                            if time.monotonic() - last_ping >= WS_KEEPALIVE_SECONDS:
                                async with send_lock:
                                    await websocket.send_json({"type": "ping"})
                                last_ping = time.monotonic()
                            continue

                        batch = [first_row]
                        while len(batch) < WS_BATCH_LIMIT:
                            try:
                                batch.append(sub.queue.get_nowait())
                            except asyncio.QueueEmpty:
                                break

                        if state["paused"]:
                            continue

                        was_dropped = sub.dropped
                        sub.dropped = False
                        max_seq = state["sent_seq"]
                        matched = []
                        cur_filters = state["filters"]
                        for row in batch:
                            if row["seq"] <= state["sent_seq"]:
                                continue
                            max_seq = max(max_seq, row["seq"])
                            if LOG_BUFFER.matches(row, **cur_filters):
                                matched.append(row)
                        state["sent_seq"] = max_seq

                        if matched or was_dropped:
                            async with send_lock:
                                await websocket.send_json({
                                    "type": "rows",
                                    "rows": matched,
                                    "truncated": was_dropped,
                                    "last_seq": state["sent_seq"],
                                    "capacity": LOG_BUFFER.capacity,
                                    "level": current_level(),
                                    "pid": os.getpid(),
                                })
                            last_ping = time.monotonic()
                except WebSocketDisconnect:
                    pass
                finally:
                    tg.cancel_scope.cancel()

            tg.start_soon(_reader)
            tg.start_soon(_writer)
    except WebSocketDisconnect:
        pass
    finally:
        LOG_BUFFER.unsubscribe(sub)


def _parse_server_ws_interval(msg: dict[str, Any]) -> float:
    raw = msg.get("interval")
    if raw is None or isinstance(raw, bool):
        return SERVER_WS_INTERVAL_SECONDS
    try:
        val = float(raw)
        if not math.isfinite(val):
            return SERVER_WS_INTERVAL_SECONDS
        return max(1.0, min(30.0, val))
    except (TypeError, ValueError):
        return SERVER_WS_INTERVAL_SECONDS


@router.websocket("/api/admin/server/ws")
async def stream_server_status(websocket: WebSocket):
    auth_info = await _ws_handshake_auth(websocket)
    if auth_info is None:
        return
    _, expires_at, first_msg = auth_info

    push_interval = _parse_server_ws_interval(first_msg)
    state = {"expires_at": expires_at, "interval": push_interval}
    refresh_event = asyncio.Event()
    send_lock = asyncio.Lock()

    try:
        initial = await run_in_threadpool(server_status)
        async with send_lock:
            await websocket.send_json({"type": "status", "data": initial})

        async with anyio.create_task_group() as tg:
            async def _reader() -> None:
                try:
                    while True:
                        msg = await websocket.receive_json()
                        if not isinstance(msg, dict):
                            continue
                        mtype = msg.get("type")
                        if mtype == "ping":
                            async with send_lock:
                                await websocket.send_json({"type": "pong"})
                        elif mtype == "pong":
                            continue
                        elif mtype == "refresh":
                            refresh_event.set()
                        elif mtype == "refresh_auth":
                            token = msg.get("token")
                            if not isinstance(token, str):
                                await _ws_send_error_and_close(websocket, WS_CLOSE_UNAUTHORIZED, "unauthorized", "Invalid token.")
                                return
                            try:
                                _, next_exp = await run_in_threadpool(_authenticate_ws_token, token)
                                state["expires_at"] = next_exp
                            except HTTPException as exc:
                                code = WS_CLOSE_FORBIDDEN if exc.status_code == 403 else WS_CLOSE_UNAUTHORIZED
                                err_code = "forbidden" if exc.status_code == 403 else "unauthorized"
                                await _ws_send_error_and_close(websocket, code, err_code, str(exc.detail))
                                return
                except WebSocketDisconnect:
                    pass
                finally:
                    tg.cancel_scope.cancel()

            async def _writer() -> None:
                last_push = time.monotonic()
                last_ping = time.monotonic()
                try:
                    while True:
                        remaining = state["expires_at"] - time.time()
                        if remaining <= 0:
                            async with send_lock:
                                await _ws_send_error_and_close(websocket, WS_CLOSE_UNAUTHORIZED, "unauthorized", "Token has expired.")
                            return

                        interval = state["interval"]
                        until_push = max(0.05, interval - (time.monotonic() - last_push))
                        wait_for = min(until_push, WS_KEEPALIVE_SECONDS, max(0.05, remaining))
                        forced_refresh = False
                        try:
                            await asyncio.wait_for(refresh_event.wait(), timeout=wait_for)
                            refresh_event.clear()
                            forced_refresh = True
                        except asyncio.TimeoutError:
                            pass

                        if state["expires_at"] <= time.time():
                            async with send_lock:
                                await _ws_send_error_and_close(websocket, WS_CLOSE_UNAUTHORIZED, "unauthorized", "Token has expired.")
                            return

                        now = time.monotonic()
                        if forced_refresh or (now - last_push >= interval):
                            snapshot = await run_in_threadpool(server_status)
                            async with send_lock:
                                await websocket.send_json({"type": "status", "data": snapshot})
                            last_push = time.monotonic()
                            last_ping = last_push
                        elif now - last_ping >= WS_KEEPALIVE_SECONDS:
                            async with send_lock:
                                await websocket.send_json({"type": "ping"})
                            last_ping = time.monotonic()
                except WebSocketDisconnect:
                    pass
                finally:
                    tg.cancel_scope.cancel()

            tg.start_soon(_reader)
            tg.start_soon(_writer)
    except WebSocketDisconnect:
        pass


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat()
