"""Headless Textual Pilot tests for EtymosTuiApp reactive layout, zoom, logs, checks, and modals."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

from tui.app import EtymosTuiApp
from tui.models import (
    ActionOutcome,
    ActionRequest,
    ApiProcessMetrics,
    BackgroundWorkMetrics,
    DiskMetrics,
    GpuMetrics,
    GpuModelInfo,
    GpuQueueState,
    LogEntry,
    LogFilterState,
    LogSourceId,
    MachineMetrics,
    ManagedServiceInfo,
    OperatingMode,
    ServerSnapshot,
    VerificationCheck,
)
from tui.providers.base import (
    ConnectionEvent,
    EventEmitFn,
    LogRowsEvent,
    LogSnapshotEvent,
    SnapshotEvent,
)
from tui.widgets.modals import ConfirmActionModal


def make_sample_snapshot(
    *,
    pid: int = 3900,
    api_online: bool = True,
    mode: OperatingMode = "local",
    active_checks: Optional[list[VerificationCheck]] = None,
    recent_checks: Optional[list[VerificationCheck]] = None,
    gpu_available: bool = True,
) -> ServerSnapshot:
    return ServerSnapshot(
        checked_at="2026-11-28T07:00:00Z",
        received_at_mono=time.monotonic(),
        mode=mode,
        api=ApiProcessMetrics(
            online=api_online,
            pid=pid if api_online else None,
            started_at="2026-11-27T14:47:30+00:00" if api_online else None,
            uptime="15h56m12s" if api_online else None,
            uptime_seconds=57372 if api_online else None,
            commit="3c52e21 Merge pull request #79" if api_online else None,
            python="3.12.11" if api_online else None,
            threads=5 if api_online else None,
            log_level="INFO" if api_online else None,
            supervised=True,
        ),
        machine=MachineMetrics(
            host="737b8587198c",
            cpus=36,
            load=(2.42, 1.34, 1.1),
            system_total_mb=96460.0,
            system_available_mb=89190.0,
            api_rss_mb=748.0 if api_online else None,
            api_peak_mb=764.0 if api_online else None,
            disk=DiskMetrics(path="/workspace", total_gb=32.0, free_gb=17.4, used_percent=45.6),
        ),
        gpu=GpuMetrics(
            available=gpu_available,
            name="NVIDIA GeForce RTX 3060" if gpu_available else None,
            total_gb=11.63 if gpu_available else None,
            free_gb=11.51 if gpu_available else None,
            allocated_gb=0.0 if (gpu_available and api_online) else None,
            peak_gb=0.0 if (gpu_available and api_online) else None,
            queue=GpuQueueState(slots=2, running=len(active_checks or []), waiting=0) if api_online else None,
            models=[GpuModelInfo("bge-m3", 2.1, 0)] if gpu_available else [],
        ),
        background=BackgroundWorkMetrics(
            notifications=True if api_online else None,
            support_inbox=True if api_online else None,
            checks_since_start=len(active_checks or []) + len(recent_checks or []),
            failed_since_start=sum(1 for c in (recent_checks or []) if c.status == "failed"),
            auto_restart="Supervisor",
        ),
        services=[
            ManagedServiceInfo("etymos-api", "RUNNING" if api_online else "STOPPED", pid if api_online else None),
            ManagedServiceInfo("cloudflared", "RUNNING", pid + 1),
            ManagedServiceInfo("etymos-deploy", "RUNNING", pid + 2),
        ],
        active_checks=active_checks or [],
        recent_checks=recent_checks or [],
    )


class FakeDashboardProvider:
    def __init__(
        self,
        *,
        mode: OperatingMode = "local",
        initial_snapshot: Optional[ServerSnapshot] = None,
        initial_logs: Optional[list[LogEntry]] = None,
        action_responses: Optional[list[ActionOutcome]] = None,
    ) -> None:
        self.mode: OperatingMode = mode
        self.target_label = "localhost" if mode == "local" else "api.etymos.site"
        self._emit: Optional[EventEmitFn] = None
        self.snapshot = initial_snapshot or make_sample_snapshot(mode=mode)
        self.initial_logs = initial_logs or [
            LogEntry(key="live:1", seq=1, ts_text="10:00:00.000", level="INFO", levelno=logging.INFO, logger="api", message="API ready"),
            LogEntry(key="live:2", seq=2, ts_text="10:00:01.000", level="WARNING", levelno=logging.WARNING, logger="jobs", message="Slow fetch", job="job_aaaa11112222"),
            LogEntry(key="live:3", seq=3, ts_text="10:00:02.000", level="ERROR", levelno=logging.ERROR, logger="api", message="Pipeline failed", exc="ValueError: boom\n  at step 2"),
        ]
        self.action_responses = list(action_responses or [])
        self.executed_actions: list[ActionRequest] = []
        self.selected_sources: list[LogSourceId] = []
        self.stopped = False

    async def start(self, emit: EventEmitFn) -> None:
        self._emit = emit
        emit(ConnectionEvent("connected" if self.snapshot.api.online else "api_offline_host_live"))
        emit(SnapshotEvent(self.snapshot))
        emit(LogSnapshotEvent("live", list(self.initial_logs), last_seq=len(self.initial_logs), pid=self.snapshot.api.pid))

    async def stop(self) -> None:
        self.stopped = True

    async def request_refresh(self) -> None:
        if self._emit:
            self._emit(SnapshotEvent(self.snapshot))

    async def set_log_source(self, source: LogSourceId) -> None:
        self.selected_sources.append(source)
        if self._emit:
            rows = (
                list(self.initial_logs)
                if source == "live"
                else [LogEntry(key=f"{source}:1", seq=1, ts_text="10:05:00", level="RAW", levelno=logging.INFO, logger=source, message=f"Line from {source}")]
            )
            self._emit(LogSnapshotEvent(source, rows, last_seq=len(rows)))

    async def set_log_filters(self, filters: LogFilterState) -> None:
        pass

    async def set_log_paused(self, paused: bool, after_seq: int = 0) -> None:
        pass

    async def execute_action(self, req: ActionRequest) -> ActionOutcome:
        self.executed_actions.append(req)
        if self.action_responses:
            return self.action_responses.pop(0)
        return ActionOutcome(ok=True, status_code=200, action=req.action, summary=f"{req.action} ok", ms=12)

    async def run_command(self, req) -> None:
        pass

    async def cancel_command(self, run_id: str) -> None:
        pass


def test_responsive_breakpoints_zoom_no_color_and_clean_exit():
    async def _run():
        provider = FakeDashboardProvider()
        app = EtymosTuiApp(provider, no_color=True)
        async with app.run_test(size=(180, 50)) as pilot:
            await pilot.pause(0.1)
            assert app.breakpoint == "wide"
            assert "-wide" in app.screen.classes

            t0 = time.perf_counter()
            await pilot.resize_terminal(120, 36)
            await pilot.pause(0.05)
            assert (time.perf_counter() - t0) < 0.5
            assert app.breakpoint == "medium" and "-medium" in app.screen.classes

            await pilot.resize_terminal(80, 24)
            await pilot.pause(0.05)
            assert app.breakpoint == "narrow" and "-narrow" in app.screen.classes

            await pilot.resize_terminal(50, 12)
            await pilot.pause(0.05)
            assert app.breakpoint == "too_small" and "-too-small" in app.screen.classes

            await pilot.resize_terminal(140, 40)
            await pilot.pause(0.05)
            assert app.breakpoint == "medium"

            # Pane zoom toggle z / Esc preserves filters and logs
            await pilot.press("l")  # INFO
            assert app.logs_pane.filters.min_level == "INFO"
            await pilot.press("z")
            await pilot.pause(0.05)
            assert app.zoomed_pane == "logs" and "-zoom-logs" in app.screen.classes
            await pilot.press("escape")
            await pilot.pause(0.05)
            assert app.zoomed_pane is None and app.logs_pane.filters.min_level == "INFO"

            await pilot.press("q")
        assert provider.stopped is True

    asyncio.run(_run())


def test_logs_streaming_burst_pause_filter_sources_and_traceback():
    async def _run():
        provider = FakeDashboardProvider()
        app = EtymosTuiApp(provider)
        async with app.run_test(size=(140, 42)) as pilot:
            await pilot.pause(0.1)
            assert len(app.logs_pane.store) == 3

            # Burst + 10k soak cap check + interactive latency
            for batch_start in range(4, 3404, 200):
                rows = [
                    LogEntry(key=f"live:{i}", seq=i, level="INFO", levelno=logging.INFO, logger="burst", message=f"burst {i}")
                    for i in range(batch_start, batch_start + 200)
                ]
                app.handle_provider_event(LogRowsEvent("live", rows, last_seq=batch_start + 199))
            app.logs_pane.flush_now()
            assert len(app.logs_pane.store) == 3000

            t_key = time.perf_counter()
            await pilot.press("p")
            key_elapsed_ms = (time.perf_counter() - t_key) * 1000.0
            assert key_elapsed_ms < 250.0
            assert app.logs_pane.paused is True

            # Unread counter grows while paused, clears on G
            app.handle_provider_event(
                LogRowsEvent(
                    "live",
                    [LogEntry(key="live:9999", seq=9999, level="ERROR", levelno=logging.ERROR, logger="api", message="later err", exc="Traceback: x")],
                    last_seq=9999,
                )
            )
            app.logs_pane.flush_now()
            assert app.logs_pane.unread_while_paused == 1

            await pilot.press("G")
            assert app.logs_pane.paused is False and app.logs_pane.unread_while_paused == 0

            # Toggle traceback expand/collapse on highlighted last entry
            await pilot.press("e")
            assert "live:9999" in app.logs_pane.expanded_tracebacks
            await pilot.press("e")
            assert "live:9999" not in app.logs_pane.expanded_tracebacks

            # Search filter via / + clear via c
            await pilot.press("slash")
            app.logs_pane._search_input.value = "later"
            await pilot.pause(0.05)
            assert app.logs_pane.filters.q == "later"
            await pilot.press("escape")
            await pilot.press("c")
            assert app.logs_pane.filters.q == ""

            # Switch log source to deploy (key 4) then back to live (key 1)
            await pilot.press("4")
            await pilot.pause(0.08)
            assert app.logs_pane.selected_source == "deploy"
            assert "deploy" in provider.selected_sources
            await pilot.press("1")
            await pilot.pause(0.08)
            assert app.logs_pane.selected_source == "live"

    asyncio.run(_run())


def test_checks_pane_empty_active_failed_and_drill_down():
    async def _run():
        # Idle empty state first
        idle_provider = FakeDashboardProvider(initial_snapshot=make_sample_snapshot())
        app_idle = EtymosTuiApp(idle_provider)
        async with app_idle.run_test(size=(150, 42)) as pilot:
            await pilot.pause(0.1)
            assert app_idle.checks_pane._empty_active.display is True
            assert app_idle.checks_pane._empty_recent.display is True
            assert app_idle.checks_pane._table.display is False

        active_chk = VerificationCheck(
            job_id="job_aaaa111122223333",
            input_type="pdf",
            input_name="thesis.pdf",
            user_id="usr12345678",
            status="processing",
            progress=65,
            current_step="matching",
            message="Comparing sources",
            age_seconds=42.0,
            step_seconds=8.0,
        )
        failed_chk = VerificationCheck(
            job_id="job_bbbb444455556666",
            input_type="docx",
            input_name="draft.docx",
            status="failed",
            progress=40,
            current_step="extracting",
            message="Failed",
            error="Corrupted archive",
            updated_at="2026-11-28T06:55:00+00:00",
        )
        provider = FakeDashboardProvider(
            initial_snapshot=make_sample_snapshot(active_checks=[active_chk], recent_checks=[failed_chk])
        )
        app = EtymosTuiApp(provider)
        async with app.run_test(size=(150, 42)) as pilot:
            await pilot.pause(0.1)
            assert app.checks_pane._table.display is True
            assert app.checks_pane._table.row_count == 2
            # Drill down via ChecksPane select_highlighted -> filters LogsPane to job_aaaa...
            app.checks_pane.select_highlighted()
            await pilot.pause(0.05)
            assert app.logs_pane.filters.job == "job_aaaa111122223333"
            assert app.focused_pane == "logs"

    asyncio.run(_run())


def test_offline_downtime_pid_restart_help_and_guarded_action_modals():
    async def _run():
        active_chk = VerificationCheck(job_id="job_active1", status="processing", progress=50, current_step="ocr")
        # 409 conflict escalation followed by forced confirmation success
        provider = FakeDashboardProvider(
            mode="remote",
            initial_snapshot=make_sample_snapshot(mode="remote", active_checks=[active_chk]),
            action_responses=[
                ActionOutcome(ok=False, status_code=409, action="restart-service", summary="1 check running", lost_checks=1),
                ActionOutcome(ok=True, status_code=200, action="restart-service", summary="restarted", ms=15),
            ],
        )
        app = EtymosTuiApp(provider)
        async with app.run_test(size=(150, 42)) as pilot:
            await pilot.pause(0.1)

            # Help modal opens on ? and closes on q WITHOUT exiting the app
            await pilot.press("question_mark")
            await pilot.pause(0.05)
            assert app.screen.__class__.__name__ == "HelpModal"
            await pilot.press("q")
            await pilot.pause(0.05)
            assert app.is_running and app.screen.__class__.__name__ != "HelpModal"

            # API offline banner + PID restart notice
            app.handle_provider_event(ConnectionEvent("api_offline_host_live"))
            app.handle_provider_event(SnapshotEvent(make_sample_snapshot(api_online=False)))
            await pilot.pause(0.05)
            assert "API OFFLINE" in app.header_bar.render().plain
            app.handle_provider_event(ConnectionEvent("connected"))
            app.handle_provider_event(SnapshotEvent(make_sample_snapshot(pid=4500, active_checks=[active_chk])))
            await pilot.pause(0.05)
            assert "3900 -> 4500" in app.restart_banner

            # ConfirmActionModal warns about active checks AND remote cloudflared disconnect
            tunnel_req = ActionRequest(action="stop-service", service="cloudflared")
            modal = ConfirmActionModal(tunnel_req, active_checks=0, mode="remote")
            app.push_screen(modal)
            await pilot.pause(0.05)
            assert "REMOTE SESSION WARNING" in str(modal.query_one("#confirm-body").render())
            await pilot.press("escape")
            await pilot.pause(0.05)

            # Force guard flow for active checks on etymos-api restart
            api_restart = ActionRequest(action="restart-service", service="etymos-api")
            app._on_action_picked(api_restart)
            await pilot.pause(0.05)
            assert isinstance(app.screen, ConfirmActionModal)
            assert app.screen.force_required is True
            # Click Force button via id
            app.screen.query_one("#btn-force-confirm").press()
            await pilot.pause(0.1)
            assert any(r.action == "restart-service" and r.force is True for r in provider.executed_actions)

    asyncio.run(_run())


def test_log_file_tab_scroll_lock_wheel_keys_append_rotation_and_resume():
    async def _run():
        api_lines = [
            LogEntry(
                key=f"api:{i}",
                seq=i,
                ts_text="10:00:00.000",
                level="RAW",
                levelno=logging.INFO,
                logger="api",
                message=f"Server log line #{i}",
            )
            for i in range(1, 81)
        ]

        class _MultiLineFileProvider(FakeDashboardProvider):
            async def set_log_source(self, source: LogSourceId) -> None:
                self.selected_sources.append(source)
                if not self._emit:
                    return
                if source == "api":
                    self._emit(LogSnapshotEvent("api", list(api_lines), last_seq=80))
                elif source == "live":
                    self._emit(LogSnapshotEvent("live", list(self.initial_logs), last_seq=len(self.initial_logs)))
                else:
                    self._emit(
                        LogSnapshotEvent(
                            source,
                            [
                                LogEntry(
                                    key=f"{source}:{i}",
                                    seq=i,
                                    ts_text="10:05:00",
                                    level="RAW",
                                    levelno=logging.INFO,
                                    logger=source,
                                    message=f"{source} row #{i}",
                                )
                                for i in range(1, 41)
                            ],
                            last_seq=40,
                        )
                    )

        provider = _MultiLineFileProvider(mode="remote")
        app = EtymosTuiApp(provider)
        async with app.run_test(size=(140, 42)) as pilot:
            await pilot.pause(0.1)

            # Switch to tab 2 (`api`) which has 80 lines (> viewport height)
            await pilot.press("2")
            await pilot.pause(0.12)
            assert app.logs_pane.selected_source == "api"
            assert app.logs_pane.paused is False
            log_list = app.logs_pane._list
            assert log_list.max_scroll_y > 10
            bottom_y = float(log_list.max_scroll_y)
            assert float(log_list.scroll_y) >= bottom_y - 1.5

            # 1. Simulate mouse wheel / trackpad upward scroll -> auto-pauses and stays pinned
            log_list.scroll_to(y=5.0, animate=False, immediate=True)
            await pilot.pause(0.1)
            assert app.logs_pane.paused is True
            assert app.logs_pane.scroll_state.paused is True
            pinned_y = float(log_list.scroll_y)
            assert pinned_y < bottom_y - 5.0

            # 2. Incremental append arrives while paused -> unread badge grows, viewport does NOT jump
            app.handle_provider_event(
                LogRowsEvent(
                    "api",
                    [
                        LogEntry(key=f"api:{n}", seq=n, level="RAW", levelno=logging.INFO, logger="api", message=f"Appended #{n}")
                        for n in (81, 82, 83)
                    ],
                    last_seq=83,
                )
            )
            app.logs_pane.flush_now()
            await pilot.pause(0.08)
            assert app.logs_pane.paused is True
            assert app.logs_pane.unread_while_paused == 3
            assert abs(float(log_list.scroll_y) - pinned_y) < 0.6

            # 3. Same-source rotation while paused -> stays paused without jumping to bottom
            rotated_rows = [
                LogEntry(key=f"api:{n}", seq=n, level="RAW", levelno=logging.INFO, logger="api", message=f"Rotated #{n}")
                for n in range(1, 51)
            ]
            app.handle_provider_event(LogSnapshotEvent("api", rotated_rows, last_seq=50))
            await pilot.pause(0.08)
            assert app.logs_pane.paused is True
            assert float(log_list.scroll_y) < float(log_list.max_scroll_y) - 1.0

            # 4. Press G -> resumes auto-follow & jumps to tail
            await pilot.press("G")
            await pilot.pause(0.08)
            assert app.logs_pane.paused is False
            assert app.logs_pane.unread_while_paused == 0
            assert float(log_list.scroll_y) >= float(log_list.max_scroll_y) - 1.0

            # 5. Keyboard PgUp -> pauses auto-follow & scrolls upward away from bottom
            await pilot.press("pageup", "pageup")
            await pilot.pause(0.08)
            assert app.logs_pane.paused is True
            assert float(log_list.scroll_y) < float(log_list.max_scroll_y) - 1.0

            # 6. Manually scrolling back to bottom edge -> resumes auto-follow cleanly
            log_list.scroll_to(y=float(log_list.max_scroll_y), animate=False, immediate=True)
            await pilot.pause(0.1)
            assert app.logs_pane.paused is False
            assert app.logs_pane.unread_while_paused == 0

            # 7. Pause on tab 2, then switch to tab 4 (`deploy`) -> fresh unpaused tail
            await pilot.press("p")
            assert app.logs_pane.paused is True
            await pilot.press("4")
            await pilot.pause(0.1)
            assert app.logs_pane.selected_source == "deploy"
            assert app.logs_pane.paused is False
            assert app.logs_pane.unread_while_paused == 0

    asyncio.run(_run())


def test_command_pane_toggle_focus_zoom_history_clear_cancel_and_destructive_guard():
    from tui.models import CommandRequest, RemoteExecCapability
    from tui.providers.base import CommandDoneEvent, CommandOutputEvent, CommandStartedEvent
    from tui.widgets.modals import ConfirmCommandModal

    async def _run():
        class _CommandCapableProvider(FakeDashboardProvider):
            def __init__(self) -> None:
                super().__init__(mode="remote")
                self.snapshot.remote_exec = RemoteExecCapability(enabled=True, sv_available=True, cwd="/workspace/Etymos")
                self.ran_commands: list[CommandRequest] = []
                self.cancelled_runs: list[str] = []
                self._cancel_ev: Optional[asyncio.Event] = None
                self.disabled_mode = False

            async def run_command(self, req: CommandRequest) -> None:
                self.ran_commands.append(req)
                if not self._emit:
                    return
                if self.disabled_mode:
                    self._emit(
                        CommandDoneEvent(
                            run_id=req.run_id,
                            status="disabled",
                            exit_code=None,
                            duration_ms=0,
                            error="Remote command execution is disabled on this server (set ADMIN_REMOTE_EXEC_ENABLED=true).",
                        )
                    )
                    return
                self._emit(CommandStartedEvent(run_id=req.run_id, cwd="/workspace/Etymos"))
                if req.command.startswith("sleep"):
                    self._cancel_ev = asyncio.Event()
                    try:
                        await asyncio.wait_for(self._cancel_ev.wait(), timeout=5.0)
                        self._emit(CommandDoneEvent(run_id=req.run_id, status="cancelled", exit_code=None, duration_ms=15, error="Cancelled"))
                    except asyncio.TimeoutError:
                        self._emit(CommandDoneEvent(run_id=req.run_id, status="completed", exit_code=0, duration_ms=5000))
                    return
                self._emit(CommandOutputEvent(run_id=req.run_id, stream="stdout", data="\x1b[32metymos-api RUNNING\x1b[0m\n"))
                self._emit(CommandDoneEvent(run_id=req.run_id, status="completed", exit_code=0, duration_ms=42))

            async def cancel_command(self, run_id: str) -> None:
                self.cancelled_runs.append(run_id)
                if self._cancel_ev is not None:
                    self._cancel_ev.set()

        provider = _CommandCapableProvider()
        app = EtymosTuiApp(provider)
        async with app.run_test(size=(150, 42)) as pilot:
            await pilot.pause(0.1)

            # Closed by default; Tab does NOT visit "command"
            assert app.command_pane.is_open is False
            await pilot.press("tab")
            assert app.focused_pane == "stats"
            await pilot.press("shift+tab")
            assert app.focused_pane == "logs"

            # Open CommandPane with `:` -> focuses prompt Input & includes "command" in Tab cycle
            await pilot.press("colon")
            await pilot.pause(0.08)
            assert app.command_pane.is_open is True
            assert "-cmd-open" in app.screen.classes
            assert app.focused_pane == "command"
            assert app.focused is app.command_pane._input

            # Submit command -> ANSI stripped, status updated, history recorded
            app.command_pane._input.value = "$SV status"
            await pilot.press("enter")
            await pilot.pause(0.1)
            assert [c.command for c in provider.ran_commands] == ["$SV status"]
            transcript = "\n".join(app.command_pane.transcript_lines)
            assert "etymos-api RUNNING" in transcript
            assert "\x1b" not in transcript
            assert app.command_pane.status == "completed"

            # History Up/Down recall preserves typed draft
            app.command_pane._input.value = "draft-text"
            await pilot.press("up")
            assert app.command_pane._input.value == "$SV status"
            await pilot.press("down")
            assert app.command_pane._input.value == "draft-text"
            app.command_pane._input.value = ""

            # Ctrl+L clears transcript
            await pilot.press("ctrl+l")
            await pilot.pause(0.05)
            assert len(app.command_pane.transcript_lines) == 0

            # Esc blurs input -> z zooms command pane -> Esc unzooms
            await pilot.press("escape")
            await pilot.pause(0.05)
            await pilot.press("z")
            await pilot.pause(0.05)
            assert app.zoomed_pane == "command" and "-zoom-command" in app.screen.classes
            await pilot.press("escape")
            await pilot.pause(0.05)
            assert app.zoomed_pane is None

            # Slow running command cancelled by smart Ctrl+C WITHOUT exiting app!
            app.command_pane.focus_prompt()
            app.command_pane._input.value = "sleep 20"
            await pilot.press("enter")
            await pilot.pause(0.05)
            assert app.command_pane.status == "running"
            await pilot.press("ctrl+c")
            await pilot.pause(0.1)
            assert app.is_running
            assert app.command_pane.status == "cancelled"
            assert len(provider.cancelled_runs) == 1

            # Second slow command cancelled by Ctrl+X
            app.command_pane._input.value = "sleep 30"
            await pilot.press("enter")
            await pilot.pause(0.05)
            await pilot.press("ctrl+x")
            await pilot.pause(0.1)
            assert app.command_pane.status == "cancelled"
            assert len(provider.cancelled_runs) == 2

            # Destructive command opens ConfirmCommandModal; Esc aborts without sending
            before_count = len(provider.ran_commands)
            app.command_pane._input.value = "git reset --hard HEAD"
            await pilot.press("enter")
            await pilot.pause(0.08)
            assert isinstance(app.screen, ConfirmCommandModal)
            await pilot.press("escape")
            await pilot.pause(0.08)
            assert len(provider.ran_commands) == before_count

            # Confirm dispatches
            app.command_pane._input.value = "git reset --hard HEAD"
            await pilot.press("enter")
            await pilot.pause(0.08)
            assert isinstance(app.screen, ConfirmCommandModal)
            app.screen.query_one("#btn-confirm-cmd").press()
            await pilot.pause(0.08)
            assert len(provider.ran_commands) == before_count + 1

            # Disabled-by-config notice renders cleanly
            provider.disabled_mode = True
            app.command_pane.focus_prompt()
            app.command_pane._input.value = "echo hi"
            await pilot.press("enter")
            await pilot.pause(0.08)
            assert app.command_pane.status == "disabled"
            assert "ADMIN_REMOTE_EXEC_ENABLED=true" in "\n".join(app.command_pane.transcript_lines)

            # Toggle closed with x outside input
            await pilot.press("escape")
            await pilot.press("x")
            await pilot.pause(0.05)
            assert app.command_pane.is_open is False
            assert "-cmd-open" not in app.screen.classes

    asyncio.run(_run())


def test_stats_cards_render_full_details_without_zoom_and_equal_heights():
    async def _run():
        class _DelayedSnapshotProvider(FakeDashboardProvider):
            async def start(self, emit: EventEmitFn) -> None:
                self._emit = emit

        provider = _DelayedSnapshotProvider(mode="remote")
        app = EtymosTuiApp(provider)
        async with app.run_test(size=(180, 50)) as pilot:
            await pilot.pause(0.08)

            # Deliver snapshot AFTER initial mount (like real remote WS stream) WITHOUT pressing z
            app.handle_provider_event(SnapshotEvent(make_sample_snapshot(mode="remote")))
            await pilot.pause(0.1)

            cards = (
                app.stats_pane.api_card,
                app.stats_pane.machine_card,
                app.stats_pane.gpu_card,
                app.stats_pane.bg_card,
            )

            def assert_cards_ok(context: str) -> None:
                heights = [c.outer_size.height for c in cards]
                assert len(set(heights)) == 1, f"{context}: unequal card heights {heights}"
                for c in cards:
                    w = max(1, c.content_size.width)
                    needed = c.get_content_height(app.stats_pane.size, app.size, w)
                    assert needed <= c.content_size.height, (
                        f"{context}: {c.id} clipped ({needed} > {c.content_size.height})"
                    )

            assert app.stats_pane.machine_card.content_size.height >= 8
            assert_cards_ok("wide-180x50-initial-delayed-snapshot")

            # Verify across wide/medium/narrow breakpoints
            for label, size in [
                ("wide-150x42", (150, 42)),
                ("medium-120x40", (120, 40)),
                ("narrow-80x24", (80, 24)),
                ("wide-180x50-restored", (180, 50)),
            ]:
                await pilot.resize_terminal(*size)
                await pilot.pause(0.1)
                assert_cards_ok(label)

            # Verify CPU-only snapshot (shorter GPU content still expands to tallest Machine card)
            app.handle_provider_event(SnapshotEvent(make_sample_snapshot(mode="remote", gpu_available=False)))
            await pilot.pause(0.1)
            assert_cards_ok("cpu-only")

            # Verify zoom enter/exit on stats keeps full equal-height cards
            app.handle_provider_event(SnapshotEvent(make_sample_snapshot(mode="remote", gpu_available=True)))
            await pilot.pause(0.1)
            app.focused_pane = "stats"
            await pilot.press("z")
            await pilot.pause(0.1)
            assert_cards_ok("zoom-stats")
            await pilot.press("z")
            await pilot.pause(0.1)
            assert_cards_ok("unzoom-stats")

            # Verify too_small breakpoint does not hang and recovers equal heights cleanly
            await pilot.resize_terminal(50, 12)
            await pilot.pause(0.08)
            assert app.breakpoint == "too_small"
            await pilot.resize_terminal(180, 50)
            await pilot.pause(0.1)
            assert_cards_ok("recovered-from-too-small")

    asyncio.run(_run())


def test_live_log_scroll_pause_resume_preserves_rows():
    import time as _time
    from tui.models import RemoteSessionCache
    from tui.providers.remote import RemoteDashboardProvider

    async def _run():
        class _FakeWs:
            def __init__(self, remote_delegate: RemoteDashboardProvider, *, pid: int = 3900) -> None:
                self.remote = remote_delegate
                self.pid = pid
                self.pending_resume_rows: list[dict] = []

            async def send(self, payload: str) -> None:
                import json as _json
                frame = _json.loads(payload)
                if frame.get("type") == "resume":
                    after = int(frame.get("after") or 0)
                    new_rows = [r for r in self.pending_resume_rows if r["seq"] > after]
                    self.pending_resume_rows.clear()
                    last_seq = new_rows[-1]["seq"] if new_rows else after
                    self.remote._handle_live_ws_frame(
                        {"type": "snapshot", "rows": new_rows, "last_seq": last_seq, "truncated": False, "pid": self.pid}
                    )

        sess = RemoteSessionCache(
            api_url="https://api.etymos.site",
            supabase_url="https://sb.example.co",
            access_token="header.payload.sig",
            refresh_token="",
            expires_at=_time.time() + 3600,
        )
        remote_delegate = RemoteDashboardProvider(api_url="https://api.etymos.site", session=sess)
        fake_ws = _FakeWs(remote_delegate, pid=3900)
        remote_delegate._logs_ws = fake_ws

        class _LiveWsSimProvider(FakeDashboardProvider):
            async def start(self, emit: EventEmitFn) -> None:
                self._emit = emit
                remote_delegate._emit = emit
                emit(ConnectionEvent("connected"))
                emit(SnapshotEvent(self.snapshot))
                remote_delegate._handle_live_ws_frame(
                    {
                        "type": "snapshot",
                        "rows": [
                            {
                                "seq": i,
                                "ts": 1700000000.0 + i,
                                "level": "INFO",
                                "levelno": logging.INFO,
                                "logger": "api",
                                "message": f"Live log line #{i}",
                            }
                            for i in range(1, 81)
                        ],
                        "last_seq": 80,
                        "truncated": False,
                        "pid": 3900,
                    }
                )

            async def set_log_paused(self, paused: bool, after_seq: int = 0) -> None:
                await remote_delegate.set_log_paused(paused, after_seq)

        provider = _LiveWsSimProvider(mode="remote")
        app = EtymosTuiApp(provider)
        async with app.run_test(size=(150, 42)) as pilot:
            await pilot.pause(0.12)
            assert app.logs_pane.selected_source == "live"
            assert len(app.logs_pane.store) == 80
            log_list = app.logs_pane._list
            assert log_list.max_scroll_y > 10

            # Scroll up -> auto-pauses
            log_list.scroll_to(y=5.0, animate=False, immediate=True)
            await pilot.pause(0.1)
            assert app.logs_pane.paused is True

            # Scroll back to bottom -> auto-resumes with empty WS resume snapshot -> all 80 rows preserved!
            log_list.scroll_to(y=float(log_list.max_scroll_y), animate=False, immediate=True)
            await pilot.pause(0.12)
            assert app.logs_pane.paused is False
            assert len(app.logs_pane.store) == 80

            # Second pause -> scroll to bottom with 2 new lines arriving while paused -> appends to 82 rows!
            log_list.scroll_to(y=5.0, animate=False, immediate=True)
            await pilot.pause(0.1)
            assert app.logs_pane.paused is True
            fake_ws.pending_resume_rows = [
                {
                    "seq": n,
                    "ts": 1700000000.0 + n,
                    "level": "INFO",
                    "levelno": logging.INFO,
                    "logger": "api",
                    "message": f"Resumed line #{n}",
                }
                for n in (81, 82)
            ]
            log_list.scroll_to(y=float(log_list.max_scroll_y), animate=False, immediate=True)
            await pilot.pause(0.15)
            app.logs_pane.flush_now()
            await pilot.pause(0.05)
            assert app.logs_pane.paused is False
            assert len(app.logs_pane.store) == 82

    asyncio.run(_run())
