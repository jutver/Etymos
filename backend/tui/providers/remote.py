"""Remote Streaming Mode provider connecting over HTTPS/WSS with MFA admin session."""
from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any, Optional
from urllib.parse import urlparse

import httpx
import websockets

from ..log_tailer import parse_log_file_line
from ..models import (
    ActionOutcome,
    ActionRequest,
    CommandRequest,
    ConnectionState,
    FilePollWatermark,
    LogFileDescriptor,
    LogFilterState,
    LogSourceId,
    RemoteSessionCache,
    compute_line_overlap_append,
    snapshot_from_api_payload,
)
from ..sanitize import sanitize_log_text
from .base import (
    AuthErrorEvent,
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
from .local import _ws_url, apply_live_ws_frame, entry_from_ws_row

BACKOFF_SECONDS = (1.0, 2.0, 4.0, 8.0, 10.0)


class RemoteDashboardProvider:
    """Streams live telemetry, live logs, log files, and actions from a remote Etymos API."""

    mode = "remote"

    def __init__(
        self,
        *,
        api_url: str,
        session: RemoteSessionCache,
        auth_manager: Optional[Any] = None,
        refresh_interval: float = 1.5,
        supabase_anon_key: Optional[str] = None,
    ) -> None:
        self.api_url = api_url.rstrip("/")
        parsed = urlparse(self.api_url)
        self.target_label = parsed.netloc or self.api_url
        self._session = session
        self._auth_manager = auth_manager
        self._supabase_anon_key = supabase_anon_key
        self.refresh_interval = max(1.0, min(30.0, float(refresh_interval)))

        self._emit: Optional[EventEmitFn] = None
        self._stop_event = asyncio.Event()
        self._tasks: list[asyncio.Task[Any]] = []
        self._conn_state: ConnectionState = "connecting"

        self._selected_source: LogSourceId = "live"
        self._filters = LogFilterState()
        self._paused = False
        self._after_seq = 0
        self._last_pid: Optional[int] = None
        self._logs_pid: Optional[int] = None
        self._expect_live_reset: bool = True
        self._pending_live_resubscribe: bool = False
        self._status_ws: Any = None
        self._logs_ws: Any = None
        self._exec_ws: Any = None
        self._active_run_id: Optional[str] = None
        self._file_poll_wake = asyncio.Event()
        self._watermarks: dict[LogSourceId, FilePollWatermark] = {}

    def _emit_safe(self, event: Any) -> None:
        if self._emit is not None:
            self._emit(event)

    def _set_connection(self, state: ConnectionState, detail: str = "") -> None:
        if state != self._conn_state or detail:
            self._conn_state = state
            self._emit_safe(ConnectionEvent(state=state, detail=detail))

    async def start(self, emit: EventEmitFn) -> None:
        self._emit = emit
        self._stop_event.clear()
        self._tasks = [
            asyncio.create_task(self._status_ws_loop(), name="tui-remote-status"),
            asyncio.create_task(self._logs_ws_loop(), name="tui-remote-logs"),
            asyncio.create_task(self._file_poll_loop(), name="tui-remote-files"),
            asyncio.create_task(self._token_refresh_loop(), name="tui-remote-refresh"),
        ]
        asyncio.create_task(self._fetch_log_files_list())

    async def stop(self) -> None:
        self._stop_event.set()
        self._file_poll_wake.set()
        if self._active_run_id:
            await self.cancel_command(self._active_run_id)
        for ws in (self._status_ws, self._logs_ws, self._exec_ws):
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
        if self._status_ws is not None:
            try:
                await self._status_ws.send(json.dumps({"type": "refresh"}))
            except Exception:
                pass
        if self._selected_source != "live":
            self._file_poll_wake.set()

    async def set_log_source(self, source: LogSourceId) -> None:
        self._selected_source = source
        if source != "live":
            self._watermarks.pop(source, None)
            await self._fetch_single_file_tail(source, replace=True)
            self._file_poll_wake.set()
        else:
            self._after_seq = 0
            self._expect_live_reset = True
            self._pending_live_resubscribe = False
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
        if self._selected_source == "live":
            if self._paused:
                self._pending_live_resubscribe = True
                return
            self._after_seq = 0
            self._expect_live_reset = True
            self._pending_live_resubscribe = False
            if self._logs_ws is not None:
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
        elif self._selected_source != "live":
            self._watermarks.pop(self._selected_source, None)
            await self._fetch_single_file_tail(self._selected_source, replace=True)

    async def set_log_paused(self, paused: bool, after_seq: int = 0) -> None:
        self._paused = paused
        self._after_seq = max(self._after_seq, after_seq)
        ws = self._logs_ws
        if self._selected_source == "live" and ws is not None:
            try:
                if paused:
                    await ws.send(json.dumps({"type": "pause"}))
                elif self._pending_live_resubscribe:
                    self._pending_live_resubscribe = False
                    self._after_seq = 0
                    self._expect_live_reset = True
                    await ws.send(
                        json.dumps({
                            "type": "subscribe",
                            "after": 0,
                            "limit": 500,
                            "filters": self._filters.to_wire_dict(),
                        })
                    )
                else:
                    effective_after = max(self._after_seq, after_seq)
                    self._expect_live_reset = effective_after == 0
                    await ws.send(json.dumps({"type": "resume", "after": effective_after}))
            except Exception:
                pass

    def _handle_live_ws_frame(self, msg: dict[str, Any]) -> None:
        apply_live_ws_frame(self, msg)

    async def execute_action(self, req: ActionRequest) -> ActionOutcome:
        started = time.perf_counter()
        payload: dict[str, Any] = {"force": req.force}
        if req.level is not None:
            payload["level"] = req.level
        if req.service is not None:
            payload["service"] = req.service
        try:
            async with httpx.AsyncClient(base_url=self.api_url, timeout=15.0) as client:
                resp = await client.post(
                    f"/api/admin/server/actions/{req.action}",
                    json=payload,
                    headers={"Authorization": f"Bearer {self._session.access_token}"},
                )
            ms = round((time.perf_counter() - started) * 1000)
            data = {}
            try:
                data = resp.json()
            except Exception:
                pass
            if resp.status_code == 200:
                await self.request_refresh()
                summary = data.get("output") or f"{req.action} completed"
                if req.action == "log-level":
                    summary = f"Log level set to {data.get('level')} (was {data.get('previous')})."
                elif req.action == "dump-threads":
                    summary = f"Wrote {data.get('threads', 0)} thread stack(s) to log."
                elif req.action == "free-gpu":
                    freed = data.get("freed") or []
                    summary = f"Unloaded GPU models: {', '.join(freed)}" if freed else "No idle GPU models to unload."
                elif req.action in ("restart-api", "shutdown-api"):
                    verb = "Restarting" if req.action == "restart-api" else "Shutting down"
                    summary = f"{verb} API (lost_checks={data.get('lost_checks', 0)})."
                return ActionOutcome(
                    ok=True,
                    status_code=200,
                    action=req.action,
                    summary=summary,
                    lost_checks=int(data.get("lost_checks") or 0),
                    ms=int(data.get("ms") or ms),
                )
            detail = sanitize_log_text(data.get("detail") or resp.text or f"HTTP {resp.status_code}", preserve_newlines=False)
            lost = 0
            if resp.status_code == 409:
                m = re.search(r"(\d+)\s+check", detail)
                if m:
                    lost = int(m.group(1))
            if resp.status_code in (401, 403):
                self._set_connection("auth_required", detail)
            return ActionOutcome(
                ok=False,
                status_code=resp.status_code,
                action=req.action,
                summary=detail,
                lost_checks=lost,
                ms=ms,
            )
        except Exception as exc:
            return ActionOutcome(
                ok=False,
                status_code=503,
                action=req.action,
                summary=sanitize_log_text(str(exc), preserve_newlines=False),
                ms=round((time.perf_counter() - started) * 1000),
            )

    async def cancel_command(self, run_id: str) -> None:
        ws = self._exec_ws
        if ws is None:
            return
        try:
            await ws.send(json.dumps({"type": "cancel", "run_id": run_id}))
        except Exception:
            pass

    async def run_command(self, req: CommandRequest) -> None:
        url = _ws_url(self.api_url, "/api/admin/server/exec/ws")
        self._active_run_id = req.run_id
        done_emitted = False
        try:
            async with websockets.connect(url, open_timeout=8.0, close_timeout=2.0) as ws:
                self._exec_ws = ws
                await ws.send(json.dumps({"type": "auth", "token": self._session.access_token}))
                first_raw = await asyncio.wait_for(ws.recv(), timeout=10.0)
                first_msg = json.loads(first_raw)
                if first_msg.get("type") == "error":
                    detail = str(first_msg.get("detail") or "Authentication failed.")
                    code = str(first_msg.get("code") or "")
                    if code in ("unauthorized", "forbidden"):
                        self._set_connection("auth_required", detail)
                        self._emit_safe(AuthErrorEvent(detail))
                    self._emit_safe(CommandDoneEvent(run_id=req.run_id, status="denied", error=detail))
                    done_emitted = True
                    return
                if first_msg.get("type") != "auth_ok":
                    self._emit_safe(CommandDoneEvent(run_id=req.run_id, status="failed", error="Unexpected auth frame."))
                    done_emitted = True
                    return

                await ws.send(
                    json.dumps(
                        {
                            "type": "run",
                            "run_id": req.run_id,
                            "command": req.command,
                            "timeout": req.timeout_seconds,
                        }
                    )
                )
                async for raw in ws:
                    msg = json.loads(raw)
                    mtype = msg.get("type")
                    if mtype == "ping":
                        await ws.send(json.dumps({"type": "pong"}))
                    elif mtype == "error":
                        detail = str(msg.get("detail") or "Command authorization error.")
                        code = str(msg.get("code") or "")
                        if code in ("unauthorized", "forbidden"):
                            self._set_connection("auth_required", detail)
                            self._emit_safe(AuthErrorEvent(detail))
                            self._emit_safe(CommandDoneEvent(run_id=req.run_id, status="denied", error=detail))
                            done_emitted = True
                        return
                    elif mtype == "started":
                        self._emit_safe(CommandStartedEvent(run_id=req.run_id, cwd=str(msg.get("cwd") or "")))
                    elif mtype == "output":
                        stream = str(msg.get("stream") or "stdout")
                        if stream not in ("stdout", "stderr", "system"):
                            stream = "stdout"
                        self._emit_safe(
                            CommandOutputEvent(
                                run_id=req.run_id,
                                stream=stream,  # type: ignore[arg-type]
                                data=str(msg.get("data") or ""),
                            )
                        )
                    elif mtype == "done":
                        self._emit_safe(
                            CommandDoneEvent(
                                run_id=req.run_id,
                                status=str(msg.get("status") or "failed"),  # type: ignore[arg-type]
                                exit_code=msg.get("exit_code") if isinstance(msg.get("exit_code"), int) else None,
                                duration_ms=int(msg.get("duration_ms") or 0),
                                truncated=bool(msg.get("truncated", False)),
                                error=msg.get("error"),
                            )
                        )
                        done_emitted = True
                        return
        except websockets.exceptions.ConnectionClosed as exc:
            if not done_emitted:
                if exc.code in (4401, 4403):
                    detail = "Session expired (4401)." if exc.code == 4401 else "Admin MFA required (4403)."
                    self._set_connection("auth_required", detail)
                    self._emit_safe(AuthErrorEvent(detail))
                    self._emit_safe(CommandDoneEvent(run_id=req.run_id, status="denied", error=detail))
                else:
                    self._emit_safe(
                        CommandDoneEvent(
                            run_id=req.run_id,
                            status="disconnected",
                            error=f"Connection closed mid-command ({exc.code}).",
                        )
                    )
        except Exception as exc:
            if not done_emitted:
                self._emit_safe(
                    CommandDoneEvent(
                        run_id=req.run_id,
                        status="disconnected",
                        error=sanitize_log_text(str(exc), preserve_newlines=False),
                    )
                )
        finally:
            self._exec_ws = None
            if self._active_run_id == req.run_id:
                self._active_run_id = None

    async def _fetch_log_files_list(self) -> None:
        try:
            async with httpx.AsyncClient(base_url=self.api_url, timeout=8.0) as client:
                resp = await client.get(
                    "/api/admin/logs/files",
                    headers={"Authorization": f"Bearer {self._session.access_token}"},
                )
            if resp.status_code == 200:
                files = [
                    LogFileDescriptor(
                        name=f["name"],
                        file=f["file"],
                        description=f.get("description", ""),
                        exists=bool(f.get("exists")),
                        size_bytes=int(f.get("size_bytes") or 0),
                        modified_at=f.get("modified_at"),
                    )
                    for f in (resp.json().get("files") or [])
                ]
                self._emit_safe(LogFilesEvent(files))
        except Exception:
            pass

    async def _fetch_single_file_tail(self, source: LogSourceId, *, replace: bool = False) -> None:
        if source == "live":
            return
        params: dict[str, Any] = {"lines": 400}
        if self._filters.q:
            params["q"] = self._filters.q
        try:
            async with httpx.AsyncClient(base_url=self.api_url, timeout=10.0) as client:
                resp = await client.get(
                    f"/api/admin/logs/files/{source}",
                    params=params,
                    headers={"Authorization": f"Bearer {self._session.access_token}"},
                )
            if resp.status_code != 200:
                return
            data = resp.json()
            lines = [str(ln) for ln in (data.get("lines") or [])]
            size_bytes = max(0, int(data.get("size_bytes") or 0))
            modified_at = data.get("modified_at")
            truncated = bool(data.get("more", False))

            prev = None if replace else self._watermarks.get(source)
            if (
                prev is not None
                and size_bytes == prev.size_bytes
                and modified_at == prev.modified_at
                and lines == prev.tail_lines
            ):
                return

            if prev is None:
                entries = [parse_log_file_line(ln, source=source, line_no=idx + 1) for idx, ln in enumerate(lines)]
                next_seq = len(entries) + 1
                self._watermarks[source] = FilePollWatermark(
                    source=source,
                    size_bytes=size_bytes,
                    modified_at=modified_at,
                    tail_lines=list(lines),
                    next_seq=next_seq,
                )
                last_seq = entries[-1].seq if entries else 0
                self._emit_safe(LogSnapshotEvent(source, entries, truncated=truncated, last_seq=last_seq))
                return

            if size_bytes < prev.size_bytes:
                delta, rotated = list(lines), True
            else:
                delta, rotated = compute_line_overlap_append(prev.tail_lines, lines)

            if not rotated and not delta:
                prev.size_bytes = size_bytes
                prev.modified_at = modified_at
                prev.tail_lines = list(lines)
                return

            if not rotated and delta:
                start_seq = prev.next_seq
                entries = [
                    parse_log_file_line(ln, source=source, line_no=start_seq + idx)
                    for idx, ln in enumerate(delta)
                ]
                prev.size_bytes = size_bytes
                prev.modified_at = modified_at
                prev.tail_lines = list(lines)
                prev.next_seq = start_seq + len(entries)
                self._emit_safe(LogRowsEvent(source, entries, truncated=False, last_seq=entries[-1].seq))
                return

            # Disjoint tail or file truncation/rotation: reset safely from sequence 1.
            entries = [parse_log_file_line(ln, source=source, line_no=idx + 1) for idx, ln in enumerate(lines)]
            self._watermarks[source] = FilePollWatermark(
                source=source,
                size_bytes=size_bytes,
                modified_at=modified_at,
                tail_lines=list(lines),
                next_seq=len(entries) + 1,
            )
            last_seq = entries[-1].seq if entries else 0
            self._emit_safe(LogSnapshotEvent(source, entries, truncated=truncated, last_seq=last_seq))
            self._emit_safe(NoticeEvent(f"Log file {source} rotated/reloaded", severity="information"))
        except Exception:
            pass

    async def _token_refresh_loop(self) -> None:
        while not self._stop_event.is_set():
            await asyncio.sleep(30.0)
            if not self._auth_manager or not self._session.refresh_token:
                continue
            if time.time() >= self._session.expires_at - 120.0:
                try:
                    updated = await asyncio.to_thread(
                        self._auth_manager.refresh_session,
                        self._session,
                        supabase_anon_key=self._supabase_anon_key,
                    )
                    self._session = updated
                    frame = json.dumps({"type": "refresh_auth", "token": updated.access_token})
                    for ws in (self._status_ws, self._logs_ws):
                        if ws is not None:
                            try:
                                await ws.send(frame)
                            except Exception:
                                pass
                except Exception as exc:
                    self._emit_safe(NoticeEvent(f"Token refresh warning: {exc}", severity="warning"))

    async def _status_ws_loop(self) -> None:
        attempt = 0
        url = _ws_url(self.api_url, "/api/admin/server/ws")
        while not self._stop_event.is_set():
            fatal_auth = False
            try:
                async with websockets.connect(url, open_timeout=8.0, close_timeout=2.0) as ws:
                    self._status_ws = ws
                    await ws.send(
                        json.dumps({
                            "type": "auth",
                            "token": self._session.access_token,
                            "interval": self.refresh_interval,
                        })
                    )
                    first_raw = await asyncio.wait_for(ws.recv(), timeout=10.0)
                    first_msg = json.loads(first_raw)
                    if first_msg.get("type") == "error":
                        code = str(first_msg.get("code") or "")
                        detail = str(first_msg.get("detail") or "Authentication failed.")
                        if code in ("unauthorized", "forbidden"):
                            fatal_auth = True
                            self._set_connection("auth_required", detail)
                            self._emit_safe(AuthErrorEvent(detail))
                            return
                        raise RuntimeError(detail)
                    if first_msg.get("type") != "auth_ok":
                        raise RuntimeError("Unexpected handshake frame")
                    attempt = 0
                    self._set_connection("connected")
                    if isinstance(first_msg.get("pid"), int):
                        new_pid = first_msg["pid"]
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
                        elif mtype == "error":
                            code = str(msg.get("code") or "")
                            detail = str(msg.get("detail") or "Auth error")
                            if code in ("unauthorized", "forbidden"):
                                fatal_auth = True
                                self._set_connection("auth_required", detail)
                                self._emit_safe(AuthErrorEvent(detail))
                                return
                        elif mtype == "status" and isinstance(msg.get("data"), dict):
                            snap = snapshot_from_api_payload(msg["data"], mode="remote")
                            if snap.api.pid is not None:
                                if self._last_pid is not None and snap.api.pid != self._last_pid:
                                    self._emit_safe(NoticeEvent(f"API restarted (PID {self._last_pid} -> {snap.api.pid})"))
                                self._last_pid = snap.api.pid
                            self._emit_safe(SnapshotEvent(snap))
            except asyncio.CancelledError:
                raise
            except websockets.exceptions.ConnectionClosed as exc:
                if exc.code in (4401, 4403):
                    fatal_auth = True
                    detail = "Session expired (4401)." if exc.code == 4401 else "Admin MFA required (4403)."
                    self._set_connection("auth_required", detail)
                    self._emit_safe(AuthErrorEvent(detail))
                    return
                self._set_connection("reconnecting")
            except Exception:
                self._set_connection("reconnecting")
            finally:
                self._status_ws = None

            if fatal_auth or self._stop_event.is_set():
                return
            delay = BACKOFF_SECONDS[min(attempt, len(BACKOFF_SECONDS) - 1)]
            attempt += 1
            await asyncio.sleep(delay)

    async def _logs_ws_loop(self) -> None:
        attempt = 0
        url = _ws_url(self.api_url, "/api/admin/logs/ws")
        while not self._stop_event.is_set():
            try:
                async with websockets.connect(url, open_timeout=8.0, close_timeout=2.0) as ws:
                    self._logs_ws = ws
                    sent_after = self._after_seq
                    if sent_after == 0:
                        self._expect_live_reset = True
                    await ws.send(
                        json.dumps({
                            "type": "auth",
                            "token": self._session.access_token,
                            "after": sent_after,
                            "limit": 500,
                            "filters": self._filters.to_wire_dict(),
                        })
                    )
                    first_raw = await asyncio.wait_for(ws.recv(), timeout=10.0)
                    first_msg = json.loads(first_raw)
                    if first_msg.get("type") != "auth_ok":
                        return
                    attempt = 0
                    auth_pid = first_msg.get("pid")
                    skip_stale_auth_snapshot = False
                    if (
                        isinstance(auth_pid, int)
                        and self._logs_pid is not None
                        and auth_pid != self._logs_pid
                        and sent_after > 0
                    ):
                        self._logs_pid = auth_pid
                        self._after_seq = 0
                        self._expect_live_reset = True
                        skip_stale_auth_snapshot = True
                        await ws.send(
                            json.dumps({
                                "type": "subscribe",
                                "after": 0,
                                "limit": 500,
                                "filters": self._filters.to_wire_dict(),
                            })
                        )
                    elif isinstance(auth_pid, int):
                        self._logs_pid = auth_pid

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
                        if mtype == "snapshot" and skip_stale_auth_snapshot:
                            skip_stale_auth_snapshot = False
                            continue
                        self._handle_live_ws_frame(msg)
            except asyncio.CancelledError:
                raise
            except websockets.exceptions.ConnectionClosed as exc:
                if exc.code in (4401, 4403):
                    return
            except Exception:
                pass
            finally:
                self._logs_ws = None

            delay = BACKOFF_SECONDS[min(attempt, len(BACKOFF_SECONDS) - 1)]
            attempt += 1
            await asyncio.sleep(delay)

    async def _file_poll_loop(self) -> None:
        while not self._stop_event.is_set():
            self._file_poll_wake.clear()
            if self._selected_source != "live":
                await self._fetch_single_file_tail(self._selected_source)
            try:
                await asyncio.wait_for(self._file_poll_wake.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                pass
