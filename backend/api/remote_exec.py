"""Opt-in remote/local shell command runner, $SV resolver, clean env, and audit redaction."""
from __future__ import annotations

import asyncio
import codecs
import logging
import os
import re
import shlex
import shutil
import signal
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

logger = logging.getLogger("api.remote_exec")

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_DIR.parent

_TRUE_VALUES = {"1", "true", "yes", "on"}
_SAFE_ENV_KEYS = ("HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ", "SHELL")

# Secret-redaction patterns for audit summaries (public.admin_action_log.summary <= 300 chars).
_REDACT_BEARER_RE = re.compile(r"(Authorization\s*:\s*Bearer\s+)[^\s'\";]+", re.IGNORECASE)
_REDACT_BARE_BEARER_RE = re.compile(r"\b(Bearer\s+)[A-Za-z0-9._\-]{6,}", re.IGNORECASE)
_REDACT_URL_CREDS_RE = re.compile(r"([a-zA-Z][a-zA-Z0-9+.\-]*://[^:/\s@]+:)([^@\s'\"]+)(@)")
_REDACT_KV_RE = re.compile(
    r"\b([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL)[A-Z0-9_]*)(=|\s+)([^\s'\";&|]+|'[^']*'|" + r'"[^"]*")',
    re.IGNORECASE,
)


def is_remote_exec_enabled() -> bool:
    """Return True only when explicitly opted in via ADMIN_REMOTE_EXEC_ENABLED."""
    raw = os.getenv("ADMIN_REMOTE_EXEC_ENABLED", "")
    return raw.strip().lower() in _TRUE_VALUES


def get_default_timeout_seconds() -> int:
    raw = os.getenv("ADMIN_REMOTE_EXEC_TIMEOUT_SECONDS", "60")
    try:
        val = int(raw)
    except (TypeError, ValueError):
        val = 60
    return max(1, min(300, val))


def get_max_timeout_seconds() -> int:
    default_to = get_default_timeout_seconds()
    raw = os.getenv("ADMIN_REMOTE_EXEC_MAX_TIMEOUT_SECONDS", "300")
    try:
        val = int(raw)
    except (TypeError, ValueError):
        val = 300
    return max(default_to, min(600, max(1, val)))


def get_max_output_bytes() -> int:
    raw = os.getenv("ADMIN_REMOTE_EXEC_MAX_OUTPUT_BYTES", "524288")
    try:
        val = int(raw)
    except (TypeError, ValueError):
        val = 524288
    return max(4096, min(4194304, val))


def clamp_timeout(raw_timeout: Any) -> int:
    default_to = get_default_timeout_seconds()
    max_to = get_max_timeout_seconds()
    if raw_timeout is None or isinstance(raw_timeout, bool):
        return default_to
    try:
        val = int(raw_timeout)
    except (TypeError, ValueError):
        return default_to
    return max(1, min(max_to, val))


def resolve_sv_env_value(backend_dir: Optional[Path] = None) -> tuple[str, Path, Path, bool]:
    """Resolve supervisorctl, supervisord.conf, and safe `$SV` value without inner-quote bugs."""
    bdir = Path(backend_dir) if backend_dir else BACKEND_DIR
    env_sv = os.getenv("SUPERVISORCTL")
    if env_sv:
        sv_bin = Path(env_sv)
    elif (bdir / ".venv" / "bin" / "supervisorctl").exists():
        sv_bin = bdir / ".venv" / "bin" / "supervisorctl"
    else:
        found = shutil.which("supervisorctl")
        sv_bin = Path(found) if found else (bdir / ".venv" / "bin" / "supervisorctl")

    env_conf = os.getenv("SUPERVISOR_CONF")
    conf = Path(env_conf) if env_conf else (bdir / "supervisord.conf")
    sv_available = sv_bin.exists() and conf.exists()

    sv_s = str(sv_bin)
    conf_s = str(conf)
    if any(ch.isspace() for ch in sv_s) or any(ch.isspace() for ch in conf_s):
        wrapper_path = Path(tempfile.gettempdir()) / f"etymos_sv_{os.getuid() if hasattr(os, 'getuid') else 0}.sh"
        script = f"#!/bin/sh\nexec {shlex.quote(sv_s)} -c {shlex.quote(conf_s)} \"$@\"\n"
        try:
            wrapper_path.write_text(script, encoding="utf-8")
            wrapper_path.chmod(0o700)
            sv_val = str(wrapper_path)
        except OSError:
            sv_val = f"{sv_s} -c {conf_s}"
    else:
        sv_val = f"{sv_s} -c {conf_s}"
    return sv_val, sv_bin, conf, sv_available


def get_remote_exec_capability(
    backend_dir: Optional[Path] = None,
    *,
    force_enabled: Optional[bool] = None,
) -> dict[str, Any]:
    bdir = Path(backend_dir) if backend_dir else BACKEND_DIR
    _, _, _, sv_available = resolve_sv_env_value(bdir)
    return {
        "enabled": is_remote_exec_enabled() if force_enabled is None else bool(force_enabled),
        "default_timeout_seconds": get_default_timeout_seconds(),
        "max_timeout_seconds": get_max_timeout_seconds(),
        "max_output_bytes": get_max_output_bytes(),
        "cwd": str(bdir.parent),
        "sv_available": sv_available,
    }


def build_safe_exec_env(
    *,
    backend_dir: Optional[Path] = None,
    log_dir: Optional[Path] = None,
) -> dict[str, str]:
    """Construct a clean subprocess environment stripping all API secrets while setting `$SV`."""
    bdir = Path(backend_dir) if backend_dir else BACKEND_DIR
    ldir = Path(log_dir) if log_dir else Path(os.getenv("LOG_DIR", str(bdir / "logs")))
    sv_val, sv_bin, conf, _ = resolve_sv_env_value(bdir)

    env: dict[str, str] = {}
    for key in _SAFE_ENV_KEYS:
        val = os.environ.get(key)
        if val:
            env[key] = val
    env.setdefault("LANG", "C.UTF-8")
    env.setdefault("TERM", "xterm-256color")

    venv_bin = bdir / ".venv" / "bin"
    base_path = os.environ.get("PATH") or "/usr/local/bin:/usr/bin:/bin"
    path_parts = base_path.split(os.pathsep) if base_path else []
    if str(venv_bin) not in path_parts:
        env["PATH"] = f"{venv_bin}{os.pathsep}{base_path}" if base_path else str(venv_bin)
    else:
        env["PATH"] = base_path

    if (bdir / ".venv").exists():
        env["VIRTUAL_ENV"] = str(bdir / ".venv")
    env["REPO_ROOT"] = str(bdir.parent)
    env["BACKEND_DIR"] = str(bdir)
    env["LOG_DIR"] = str(ldir)
    env["SUPERVISORCTL"] = str(sv_bin)
    env["SUPERVISOR_CONF"] = str(conf)
    env["SV"] = sv_val
    return env


def redact_command_for_audit(command: str) -> str:
    """Mask likely secrets/credentials in command text and bound to 300 chars."""
    text = re.sub(r"[\r\n\x00-\x1f\x7f]+", " ", (command or "").strip())
    text = _REDACT_BEARER_RE.sub(r"\1[REDACTED]", text)
    text = _REDACT_BARE_BEARER_RE.sub(r"\1[REDACTED]", text)
    text = _REDACT_URL_CREDS_RE.sub(r"\1[REDACTED]\3", text)
    text = _REDACT_KV_RE.sub(r"\1\2[REDACTED]", text)
    if len(text) > 300:
        return text[:297] + "..."
    return text


def record_command_audit(
    actor_id: str,
    *,
    action: str,
    run_id: str,
    command: str,
    status: str,
    exit_code: Optional[int] = None,
    duration_ms: int = 0,
    truncated: bool = False,
    output_bytes: int = 0,
    record_fn: Optional[Callable[..., Any]] = None,
) -> None:
    """Best-effort redacted audit write via `admin_log.record_admin_action`."""
    try:
        fn = record_fn
        if fn is None:
            mod = sys.modules.get("admin_log") or sys.modules.get("api.admin_log")
            if mod is None:
                try:
                    import admin_log as mod  # type: ignore[no-redef]
                except ImportError:
                    from api import admin_log as mod  # type: ignore[no-redef]
            fn = getattr(mod, "record_admin_action", None)
        if fn is None:
            return
        fn(
            actor_id,
            action,
            target_table="server",
            target_id=run_id,
            summary=redact_command_for_audit(command),
            metadata={
                "status": status,
                "exit_code": exit_code,
                "duration_ms": max(0, int(duration_ms)),
                "truncated": bool(truncated),
                "output_bytes": max(0, int(output_bytes)),
                "ms": max(0, int(duration_ms)),
            },
        )
    except Exception:
        logger.debug("Command audit record failed cleanly", exc_info=True)


@dataclass
class CommandExecResult:
    status: str
    exit_code: Optional[int]
    duration_ms: int
    truncated: bool
    output_bytes: int
    error: Optional[str] = None


async def _terminate_process_group(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is not None:
        return
    pid = proc.pid
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    except PermissionError:
        proc.terminate()
    try:
        await asyncio.wait_for(proc.wait(), timeout=1.0)
        return
    except asyncio.TimeoutError:
        pass
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    except PermissionError:
        proc.kill()
    try:
        await asyncio.wait_for(proc.wait(), timeout=2.0)
    except asyncio.TimeoutError:
        pass


async def run_shell_command_stream(
    *,
    command: str,
    timeout_seconds: int,
    max_output_bytes: int,
    on_output: Callable[[str, str], Awaitable[None]],
    cancel_event: Optional[asyncio.Event] = None,
    backend_dir: Optional[Path] = None,
    log_dir: Optional[Path] = None,
) -> CommandExecResult:
    """Execute one stateless command under `/bin/bash -c` with streaming, cancel, and bounds."""
    bdir = Path(backend_dir) if backend_dir else BACKEND_DIR
    cwd = bdir.parent
    if not cwd.exists():
        cwd = bdir
    env = build_safe_exec_env(backend_dir=bdir, log_dir=log_dir)

    started = time.perf_counter()
    try:
        proc = await asyncio.create_subprocess_exec(
            "/bin/bash",
            "-c",
            command,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(cwd),
            env=env,
            start_new_session=True,
        )
    except Exception as exc:
        return CommandExecResult(
            status="failed",
            exit_code=None,
            duration_ms=round((time.perf_counter() - started) * 1000),
            truncated=False,
            output_bytes=0,
            error=str(exc),
        )

    state = {"bytes": 0, "truncated": False}
    byte_lock = asyncio.Lock()

    async def _pump(stream_name: str, pipe: Optional[asyncio.StreamReader]) -> None:
        if pipe is None:
            return
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        while True:
            chunk = await pipe.read(4096)
            if not chunk:
                tail = decoder.decode(b"", final=True)
                if tail and not state["truncated"]:
                    await on_output(stream_name, tail)
                break
            async with byte_lock:
                if state["truncated"]:
                    # Drain silently until process ends or caps out.
                    continue
                remaining = max_output_bytes - state["bytes"]
                if remaining <= 0:
                    state["truncated"] = True
                    continue
                if len(chunk) > remaining:
                    allowed = chunk[:remaining]
                    state["bytes"] += len(allowed)
                    state["truncated"] = True
                    text = decoder.decode(allowed, final=True)
                    if text:
                        await on_output(stream_name, text)
                    continue
                state["bytes"] += len(chunk)
                text = decoder.decode(chunk, final=False)
            if text:
                await on_output(stream_name, text)

    pump_out = asyncio.create_task(_pump("stdout", proc.stdout))
    pump_err = asyncio.create_task(_pump("stderr", proc.stderr))
    wait_task = asyncio.create_task(proc.wait())
    cancel_task = asyncio.create_task(cancel_event.wait()) if cancel_event is not None else None

    status = "completed"
    error: Optional[str] = None
    try:
        watch: set[asyncio.Task[Any]] = {wait_task}
        if cancel_task is not None:
            watch.add(cancel_task)
        done, _ = await asyncio.wait(watch, timeout=float(timeout_seconds), return_when=asyncio.FIRST_COMPLETED)
        if cancel_task is not None and cancel_task in done and cancel_event is not None and cancel_event.is_set():
            status = "cancelled"
            error = "Cancelled by operator."
            await _terminate_process_group(proc)
        elif wait_task not in done:
            status = "timed_out"
            error = f"Command timed out after {timeout_seconds}s."
            await _terminate_process_group(proc)
        else:
            rc = wait_task.result()
            status = "completed" if rc == 0 else "failed"
    finally:
        if cancel_task is not None and not cancel_task.done():
            cancel_task.cancel()
        if not wait_task.done():
            await _terminate_process_group(proc)
        await asyncio.gather(pump_out, pump_err, return_exceptions=True)

    exit_code = proc.returncode
    duration_ms = max(0, round((time.perf_counter() - started) * 1000))
    return CommandExecResult(
        status=status,
        exit_code=exit_code,
        duration_ms=duration_ms,
        truncated=state["truncated"],
        output_bytes=state["bytes"],
        error=error,
    )
