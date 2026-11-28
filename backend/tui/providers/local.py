"""Local Server Mode provider: always-on host/GPU/supervisor collector + loopback API overlay."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import platform
import shutil
import socket
import subprocess
import time
from pathlib import Path
from typing import Any, Optional

import httpx
import psutil
import websockets

from ..log_tailer import LocalLogFileTailer
from ..models import (
    ActionOutcome,
    ActionRequest,
    CommandRequest,
    ConnectionState,
    DiskMetrics,
    GpuMetrics,
    LogEntry,
    LogFilterState,
    LogSourceId,
    MachineMetrics,
    RemoteExecCapability,
    ServerSnapshot,
    merge_local_and_api_snapshot,
)
from ..sanitize import format_log_time, sanitize_log_text
from ..supervisor_ctl import LocalSupervisorController, default_backend_dir
from .base import (
    CommandDoneEvent,
    CommandOutputEvent,
    CommandStartedEvent,
    ConnectionEvent,
    EventEmitFn,
    LogFilesEvent,
    LogRowsEvent,
    LogSnapshotEvent,
    NoticeEvent,
    SnapshotEvent,
)

try:
    import remote_exec as _remote_exec
except ImportError:  # pragma: no cover - package import fallback
    from api import remote_exec as _remote_exec

logger = logging.getLogger("tui.provider.local")

LOCAL_TOKEN_FILENAME = ".local_ops_token"
LOCAL_TOKEN_HEADER = "X-Local-Ops-Token"


def _ws_url(base_url: str, path: str) -> str:
    clean = base_url.rstrip("/")
    if clean.startswith("https://"):
        return "wss://" + clean[len("https://") :] + path
    if clean.startswith("http://"):
        return "ws://" + clean[len("http://") :] + path
    return f"ws://{clean}{path}"


def _probe_nvidia_smi_sync(timeout: float = 1.5) -> GpuMetrics:
    """Probe GPU stats cleanly via `nvidia-smi` without ever importing `torch`."""
    exe = shutil.which("nvidia-smi")
    if not exe:
        return GpuMetrics(available=False)
    try:
        proc = subprocess.run(
            [
                exe,
                "--query-gpu=name,memory.total,memory.free,memory.used,utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if proc.returncode != 0:
            err = sanitize_log_text(proc.stderr or proc.stdout, preserve_newlines=False).strip()
            return GpuMetrics(available=False, error=err or f"nvidia-smi exit {proc.returncode}")
        first = next((ln.strip() for ln in proc.stdout.splitlines() if ln.strip()), "")
        if not first:
            return GpuMetrics(available=False)
        parts = [p.strip() for p in first.split(",")]
        name = parts[0] if len(parts) > 0 else "NVIDIA GPU"
        total_mb = float(parts[1]) if len(parts) > 1 and parts[1] not in ("", "[N/A]") else None
        free_mb = float(parts[2]) if len(parts) > 2 and parts[2] not in ("", "[N/A]") else None
        util = float(parts[4]) if len(parts) > 4 and parts[4] not in ("", "[N/A]") else None
        return GpuMetrics(
            available=True,
            name=name,
            total_gb=round(total_mb / 1024.0, 2) if total_mb is not None else None,
            free_gb=round(free_mb / 1024.0, 2) if free_mb is not None else None,
            utilization_pct=util,
        )
    except Exception as exc:
        return GpuMetrics(available=False, error=sanitize_log_text(str(exc), preserve_newlines=False))


def collect_local_host_snapshot_sync(
    *,
    backend_dir: Path,
    supervisor: LocalSupervisorController,
) -> ServerSnapshot:
    """Collect host CPU/RAM/disk, lightweight GPU, and supervisor state locally."""
    try:
        load_raw = os.getloadavg()
        load = (round(load_raw[0], 2), round(load_raw[1], 2), round(load_raw[2], 2))
    except OSError:
        load = None

    vm = psutil.virtual_memory()
    disk = None
    try:
        du = shutil.disk_usage(backend_dir)
        gb = 1024 ** 3
        disk = DiskMetrics(
            path=str(backend_dir),
            total_gb=round(du.total / gb, 1),
            free_gb=round(du.free / gb, 1),
            used_percent=round(du.used / du.total * 100.0, 1) if du.total else 0.0,
        )
    except OSError:
        disk = None

    gpu = _probe_nvidia_smi_sync()
    services = supervisor.list_services()
    cap_raw = _remote_exec.get_remote_exec_capability(backend_dir, force_enabled=True)
    return ServerSnapshot(
        checked_at="",
        received_at_mono=time.monotonic(),
        mode="local",
        machine=MachineMetrics(
            host=socket.gethostname(),
            platform=platform.platform(terse=True),
            cpus=os.cpu_count(),
            load=load,
            system_total_mb=round(vm.total / (1024 * 1024), 1),
            system_available_mb=round(vm.available / (1024 * 1024), 1),
            disk=disk,
        ),
        gpu=gpu,
        services=services,
        remote_exec=RemoteExecCapability(**cap_raw),
    )


def entry_from_ws_row(raw: dict[str, Any]) -> LogEntry:
    ts = raw.get("ts")
    ts_float = float(ts) if isinstance(ts, (int, float)) else None
    seq = int(raw.get("seq") or 1)
    return LogEntry(
        key=f"live:{seq}",
        seq=seq,
        ts=ts_float,
        ts_text=format_log_time(ts_float),
        level=str(raw.get("level") or "INFO"),
        levelno=int(raw.get("levelno") or logging.INFO),
        logger=str(raw.get("logger") or "-"),
        message=str(raw.get("message") or ""),
        exc=raw.get("exc"),
        job=raw.get("job"),
        request=raw.get("request"),
        user=raw.get("user"),
    )


class LocalDashboardProvider:
    """Always-on local server telemetry + loopback API WS stream + file tailer."""

    mode = "local"

    def __init__(
        self,
        *,
        api_url: str = "http://127.0.0.1:8000",
        backend_dir: Optional[Path] = None,
        log_dir: Optional[Path] = None,
        refresh_interval: float = 1.5,
        supervisor: Optional[LocalSupervisorController] = None,
    ) -> None:
        self.api_url = api_url.rstrip("/")
        self.target_label = "localhost"
        self.backend_dir = Path(backend_dir) if backend_dir else default_backend_dir()
        self.log_dir = Path(log_dir) if log_dir else Path(os.getenv("LOG_DIR", str(self.backend_dir / "logs")))
        self.refresh_interval = max(1.0, min(30.0, float(refresh_interval)))
        self.supervisor = supervisor or LocalSupervisorController(backend_dir=self.backend_dir)
        self.tailer = LocalLogFileTailer(self.log_dir)

        self._emit: Optional[EventEmitFn] = None
        self._stop_event = asyncio.Event()
        self._tasks: list[asyncio.Task[Any]] = []
        self._refresh_signal = asyncio.Event()

        self._local_snap = ServerSnapshot(mode="local")
        self._api_payload: Optional[dict[str, Any]] = None
        self._api_online = False
        self._conn_state: ConnectionState = "connecting"

        self._selected_source: LogSourceId = "live"
        self._filters = LogFilterState()
        self._paused = False
        self._after_seq = 0

        self._status_ws: Any = None
        self._logs_ws: Any = None
        self._last_pid: Optional[int] = None
        self._exec_cancel_events: dict[str, asyncio.Event] = {}

    def _read_local_token(self) -> Optional[str]:
        path = self.log_dir / LOCAL_TOKEN_FILENAME
        try:
            tok = path.read_text(encoding="utf-8").strip()
            return tok or None
        except OSError:
            return None

    def _emit_safe(self, event: Any) -> None:
        if self._emit is not None:
            self._emit(event)

    def _emit_merged_snapshot(self) -> None:
        merged = merge_local_and_api_snapshot(
            self._local_snap,
            self._api_payload,
            api_online=self._api_online,
            received_at_mono=time.monotonic(),
        )
        self._emit_safe(SnapshotEvent(merged))

    def _set_connection(self, state: ConnectionState, detail: str = "") -> None:
        if state != self._conn_state or detail:
            self._conn_state = state
            self._emit_safe(ConnectionEvent(state=state, detail=detail))

    async def start(self, emit: EventEmitFn) -> None:
        self._emit = emit
        self._stop_event.clear()
        self._emit_safe(LogFilesEvent(self.tailer.describe_files()))
        self._tasks = [
            asyncio.create_task(self._host_poll_loop(), name="tui-local-host"),
            asyncio.create_task(self._api_status_ws_loop(), name="tui-local-status-ws"),
            asyncio.create_task(self._api_logs_ws_loop(), name="tui-local-logs-ws"),
            asyncio.create_task(self._file_tail_loop(), name="tui-local-file-tail"),
        ]

    async def stop(self) -> None:
        self._stop_event.set()
        self._refresh_signal.set()
        for ev in list(self._exec_cancel_events.values()):
            ev.set()
        for ws in (self._status_ws, self._logs_ws):
            if ws is not None:
                try:
                    await ws.close()
                except Exception:
                    pass
        for task in self._tasks:
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

    async def request_refresh(self) -> None:
        self._refresh_signal.set()
        ws = self._status_ws
        if ws is not None:
            try:
                await ws.send(json.dumps({"type": "refresh"}))
            except Exception:
                pass

    async def set_log_source(self, source: LogSourceId) -> None:
        self._selected_source = source
        if source != "live":
            self.tailer.reset_source(source)
            entries, truncated = await asyncio.to_thread(self.tailer.read_initial, source)
            last_seq = entries[-1].seq if entries else 0
            self._emit_safe(LogSnapshotEvent(source=source, rows=entries, truncated=truncated, last_seq=last_seq))
        else:
            ws = self._logs_ws
            if ws is not None and not self._paused:
                try:
                    await ws.send(
                        json.dumps({
                            "type": "subscribe",
                            "after": 0,
                            "limit": 500,
                            "filters": self._filters.to_wire_dict(),
                        })
                    )
                except Exception:
                    pass

    async def set_log_filters(self, filters: LogFilterState) -> None:
        self._filters = filters
        if self._selected_source == "live" and self._logs_ws is not None and not self._paused:
            try:
                await self._logs_ws.send(
                    json.dumps({
                        "type": "subscribe",
                        "after": 0,
                        "limit": 500,
                        "filters": filters.to_wire_dict(),
                    })
                )
            except Exception:
                pass

    async def set_log_paused(self, paused: bool, after_seq: int = 0) -> None:
        self._paused = paused
        self._after_seq = max(self._after_seq, after_seq)
        ws = self._logs_ws
        if self._selected_source == "live" and ws is not None:
            try:
                if paused:
                    await ws.send(json.dumps({"type": "pause"}))
                else:
                    await ws.send(json.dumps({"type": "resume", "after": after_seq or self._after_seq}))
            except Exception:
                pass

    async def execute_action(self, req: ActionRequest) -> ActionOutcome:
        started = time.perf_counter()
        if self._api_online:
            token = self._read_local_token()
            if token:
                payload: dict[str, Any] = {"force": req.force}
                if req.level is not None:
                    payload["level"] = req.level
                if req.service is not None:
                    payload["service"] = req.service
                try:
                    async with httpx.AsyncClient(base_url=self.api_url, timeout=12.0) as client:
                        resp = await client.post(
                            f"/api/admin/server/actions/{req.action}",
                            json=payload,
                            headers={LOCAL_TOKEN_HEADER: token},
                        )
                    ms = round((time.perf_counter() - started) * 1000)
                    data = {}
                    try:
                        data = resp.json()
                    except Exception:
                        pass
                    if resp.status_code == 200:
                        await self.request_refresh()
                        return ActionOutcome(
                            ok=True,
                            status_code=200,
                            action=req.action,
                            summary=self._summarize_api_outcome(req, data),
                            lost_checks=int(data.get("lost_checks") or 0),
                            ms=int(data.get("ms") or ms),
                        )
                    detail = sanitize_log_text(data.get("detail") or resp.text or f"HTTP {resp.status_code}", preserve_newlines=False)
                    lost = 0
                    if resp.status_code == 409:
                        import re
                        m = re.search(r"(\d+)\s+check", detail)
                        if m:
                            lost = int(m.group(1))
                    return ActionOutcome(
                        ok=False,
                        status_code=resp.status_code,
                        action=req.action,
                        summary=detail,
                        lost_checks=lost,
                        ms=ms,
                    )
                except httpx.HTTPError:
                    # Fall through to local supervisor fallback for service actions when API just dropped.
                    pass

        # Offline fallback for supervisor-managed services directly on host
        verb_map = {
            "start-service": ("start", req.service),
            "restart-service": ("restart", req.service),
            "stop-service": ("stop", req.service),
            "restart-api": ("restart", "etymos-api"),
            "shutdown-api": ("stop", "etymos-api"),
        }
        if req.action in verb_map:
            verb, service = verb_map[req.action]
            assert service is not None
            ok, msg = await asyncio.to_thread(self.supervisor.control_service, verb, service)  # type: ignore[arg-type]
            ms = round((time.perf_counter() - started) * 1000)
            self._refresh_signal.set()
            return ActionOutcome(ok=ok, status_code=200 if ok else 500, action=req.action, summary=msg, ms=ms)

        return ActionOutcome(
            ok=False,
            status_code=503,
            action=req.action,
            summary="API is offline; only supervisor service actions (start/restart/stop) are available offline.",
            ms=round((time.perf_counter() - started) * 1000),
        )

    async def cancel_command(self, run_id: str) -> None:
        ev = self._exec_cancel_events.get(run_id)
        if ev is not None:
            ev.set()

    async def run_command(self, req: CommandRequest) -> None:
        if self._exec_cancel_events:
            self._emit_safe(
                CommandDoneEvent(
                    run_id=req.run_id,
                    status="failed",
                    error="Another command is already running.",
                )
            )
            return

        cancel_ev = asyncio.Event()
        self._exec_cancel_events[req.run_id] = cancel_ev
        cwd = str(self.backend_dir.parent)
        self._emit_safe(CommandStartedEvent(run_id=req.run_id, cwd=cwd))

        async def _on_output(stream_name: str, chunk: str) -> None:
            self._emit_safe(
                CommandOutputEvent(
                    run_id=req.run_id,
                    stream=stream_name,  # type: ignore[arg-type]
                    data=chunk,
                )
            )

        try:
            res = await _remote_exec.run_shell_command_stream(
                command=req.command,
                timeout_seconds=_remote_exec.clamp_timeout(req.timeout_seconds),
                max_output_bytes=_remote_exec.get_max_output_bytes(),
                on_output=_on_output,
                cancel_event=cancel_ev,
                backend_dir=self.backend_dir,
                log_dir=self.log_dir,
            )
            try:
                await asyncio.to_thread(
                    lambda: _remote_exec.record_command_audit(
                        "local-tui",
                        action="server.exec",
                        run_id=req.run_id,
                        command=req.command,
                        status=res.status,
                        exit_code=res.exit_code,
                        duration_ms=res.duration_ms,
                        truncated=res.truncated,
                        output_bytes=res.output_bytes,
                    )
                )
            except Exception:
                pass
            self._emit_safe(
                CommandDoneEvent(
                    run_id=req.run_id,
                    status=res.status,  # type: ignore[arg-type]
                    exit_code=res.exit_code,
                    duration_ms=res.duration_ms,
                    truncated=res.truncated,
                    error=res.error,
                )
            )
        finally:
            self._exec_cancel_events.pop(req.run_id, None)

    @staticmethod
    def _summarize_api_outcome(req: ActionRequest, data: dict[str, Any]) -> str:
        if req.action == "log-level":
            return f"Log level set to {data.get('level')} (was {data.get('previous')})."
        if req.action == "dump-threads":
            return f"Wrote {data.get('threads', 0)} thread stack(s) to API log."
        if req.action == "free-gpu":
            freed = data.get("freed") or []
            return f"Unloaded GPU models: {', '.join(freed)}" if freed else "No idle GPU models to unload."
        if req.action in ("run-notifications", "poll-support-inbox"):
            counts = {k: v for k, v in (data.get("counts") or {}).items() if v}
            return ", ".join(f"{k}={v}" for k, v in counts.items()) or "Completed (nothing due)."
        if req.action in ("restart-api", "shutdown-api"):
            verb = "Restarting" if req.action == "restart-api" else "Shutting down"
            return f"{verb} API process (lost_checks={data.get('lost_checks', 0)})."
        return str(data.get("output") or f"{req.service or req.action}: {data.get('verb', 'ok')} queued.")

    async def _host_poll_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                snap = await asyncio.to_thread(
                    collect_local_host_snapshot_sync,
                    backend_dir=self.backend_dir,
                    supervisor=self.supervisor,
                )
                self._local_snap = snap
                self._emit_merged_snapshot()
                self._emit_safe(LogFilesEvent(await asyncio.to_thread(self.tailer.describe_files)))
            except Exception as exc:
                logger.debug("Host poll failed: %s", exc)
            self._refresh_signal.clear()
            try:
                await asyncio.wait_for(self._refresh_signal.wait(), timeout=self.refresh_interval)
            except asyncio.TimeoutError:
                pass

    async def _api_status_ws_loop(self) -> None:
        backoff = [1.0, 2.0, 4.0, 5.0]
        attempt = 0
        url = _ws_url(self.api_url, "/api/admin/server/ws")
        while not self._stop_event.is_set():
            token = self._read_local_token()
            if not token:
                self._api_online = False
                self._api_payload = None
                self._set_connection("api_offline_host_live")
                self._emit_merged_snapshot()
                await asyncio.sleep(min(3.0, backoff[min(attempt, len(backoff) - 1)]))
                attempt += 1
                continue
            try:
                async with websockets.connect(url, open_timeout=3.0, close_timeout=2.0) as ws:
                    self._status_ws = ws
                    await ws.send(json.dumps({"type": "auth", "local_token": token, "interval": self.refresh_interval}))
                    auth_raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
                    auth_msg = json.loads(auth_raw)
                    if auth_msg.get("type") != "auth_ok":
                        raise RuntimeError(auth_msg.get("detail") or "Local ops auth rejected")
                    attempt = 0
                    self._api_online = True
                    self._set_connection("connected")
                    new_pid = auth_msg.get("pid")
                    if isinstance(new_pid, int):
                        if self._last_pid is not None and new_pid != self._last_pid:
                            self._emit_safe(NoticeEvent(f"API restarted (PID {self._last_pid} -> {new_pid})"))
                        self._last_pid = new_pid

                    async for raw in ws:
                        if self._stop_event.is_set():
                            break
                        msg = json.loads(raw)
                        mtype = msg.get("type")
                        if mtype == "ping":
                            await ws.send(json.dumps({"type": "pong"}))
                        elif mtype == "status" and isinstance(msg.get("data"), dict):
                            self._api_payload = msg["data"]
                            proc_pid = (self._api_payload.get("process") or {}).get("pid")
                            if isinstance(proc_pid, int):
                                if self._last_pid is not None and proc_pid != self._last_pid:
                                    self._emit_safe(NoticeEvent(f"API restarted (PID {self._last_pid} -> {proc_pid})"))
                                self._last_pid = proc_pid
                            self._emit_merged_snapshot()
            except asyncio.CancelledError:
                raise
            except Exception:
                self._api_online = False
                self._api_payload = None
                self._set_connection("api_offline_host_live")
                self._emit_merged_snapshot()
            finally:
                self._status_ws = None

            delay = backoff[min(attempt, len(backoff) - 1)]
            attempt += 1
            await asyncio.sleep(delay)

    async def _api_logs_ws_loop(self) -> None:
        backoff = [1.0, 2.0, 4.0, 5.0]
        attempt = 0
        url = _ws_url(self.api_url, "/api/admin/logs/ws")
        while not self._stop_event.is_set():
            token = self._read_local_token()
            if not token:
                await asyncio.sleep(2.0)
                continue
            try:
                async with websockets.connect(url, open_timeout=3.0, close_timeout=2.0) as ws:
                    self._logs_ws = ws
                    await ws.send(
                        json.dumps({
                            "type": "auth",
                            "local_token": token,
                            "after": self._after_seq,
                            "limit": 500,
                            "filters": self._filters.to_wire_dict(),
                        })
                    )
                    auth_raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
                    auth_msg = json.loads(auth_raw)
                    if auth_msg.get("type") != "auth_ok":
                        raise RuntimeError(auth_msg.get("detail") or "Logs WS auth rejected")
                    attempt = 0
                    if self._paused:
                        await ws.send(json.dumps({"type": "pause"}))

                    async for raw in ws:
                        if self._stop_event.is_set():
                            break
                        msg = json.loads(raw)
                        mtype = msg.get("type")
                        if mtype == "ping":
                            await ws.send(json.dumps({"type": "pong"}))
                            continue
                        if mtype not in ("snapshot", "rows"):
                            continue
                        rows = [entry_from_ws_row(r) for r in (msg.get("rows") or []) if isinstance(r, dict)]
                        last_seq = int(msg.get("last_seq") or self._after_seq)
                        self._after_seq = last_seq
                        truncated = bool(msg.get("truncated", False))
                        pid = msg.get("pid") if isinstance(msg.get("pid"), int) else None
                        if mtype == "snapshot":
                            self._emit_safe(LogSnapshotEvent("live", rows, truncated=truncated, last_seq=last_seq, pid=pid))
                        else:
                            self._emit_safe(LogRowsEvent("live", rows, truncated=truncated, last_seq=last_seq, pid=pid))
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            finally:
                self._logs_ws = None

            delay = backoff[min(attempt, len(backoff) - 1)]
            attempt += 1
            await asyncio.sleep(delay)

    async def _file_tail_loop(self) -> None:
        while not self._stop_event.is_set():
            src = self._selected_source
            if src != "live":
                try:
                    rows, reset_needed = await asyncio.to_thread(self.tailer.poll_appends, src)
                    if reset_needed:
                        last_seq = rows[-1].seq if rows else 0
                        self._emit_safe(LogSnapshotEvent(src, rows, truncated=False, last_seq=last_seq))
                        self._emit_safe(NoticeEvent(f"Log file {src} rotated/reloaded", severity="information"))
                    elif rows:
                        last_seq = rows[-1].seq
                        self._emit_safe(LogRowsEvent(src, rows, truncated=False, last_seq=last_seq))
                except Exception:
                    pass
            await asyncio.sleep(0.5)
