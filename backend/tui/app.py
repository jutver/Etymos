"""Reactive Textual App + Layout Engine for the Etymos Server TUI Dashboard."""
from __future__ import annotations

import os
from typing import Optional

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.events import Resize
from textual.widgets import Input, Static

from .models import (
    ActionRequest,
    ConnectionState,
    LOG_SOURCE_ORDER,
    LogSourceId,
    PaneId,
    ServerSnapshot,
    ViewportBreakpoint,
    compute_breakpoint,
)
from .providers.base import (
    AuthErrorEvent,
    ConnectionEvent,
    DashboardProvider,
    LogFilesEvent,
    LogRowsEvent,
    LogSnapshotEvent,
    NoticeEvent,
    ProviderEvent,
    SnapshotEvent,
)
from .widgets.checks_pane import CheckSelected, ChecksPane
from .widgets.header_bar import HeaderBar
from .widgets.logs_pane import LogFiltersChanged, LogPauseChanged, LogSourceChanged, LogsPane
from .widgets.modals import ActionsModal, ConfirmActionModal, HelpModal, is_disruptive_action
from .widgets.stats_cards import StatsGrid

PANE_ORDER: tuple[PaneId, ...] = ("stats", "checks", "logs")


class EtymosTuiApp(App[int]):
    """Dynamic terminal operational dashboard with reactive breakpoints and pane zoom."""

    CSS_PATH = "styles.tcss"

    BINDINGS = [
        Binding("q", "quit_dashboard", "Quit"),
        Binding("question_mark", "show_help", "Help"),
        Binding("f1", "show_help", "Help", show=False),
        Binding("tab", "focus_next_pane", "Next Pane", priority=True),
        Binding("shift+tab", "focus_prev_pane", "Prev Pane", priority=True),
        Binding("z", "toggle_zoom", "Zoom Pane"),
        Binding("escape", "handle_escape", "Back/Close"),
        Binding("1", "switch_source(0)", "Live", show=False),
        Binding("2", "switch_source(1)", "api", show=False),
        Binding("3", "switch_source(2)", "api-out", show=False),
        Binding("4", "switch_source(3)", "deploy", show=False),
        Binding("5", "switch_source(4)", "tests", show=False),
        Binding("6", "switch_source(5)", "tunnel", show=False),
        Binding("7", "switch_source(6)", "supervisor", show=False),
        Binding("8", "switch_source(7)", "autostart", show=False),
        Binding("left_square_bracket", "prev_source", "Prev Log", show=False),
        Binding("right_square_bracket", "next_source", "Next Log", show=False),
        Binding("p", "toggle_pause", "Pause"),
        Binding("space", "toggle_pause", "Pause", show=False),
        Binding("slash", "focus_search", "Search"),
        Binding("l", "cycle_level", "Level"),
        Binding("c", "clear_filters", "Clear Filters"),
        Binding("r", "refresh_now", "Refresh"),
        Binding("a", "open_actions", "Actions"),
        Binding("ctrl+p", "open_actions", "Actions", show=False),
        Binding("up", "cursor_up", "Up", show=False),
        Binding("down", "cursor_down", "Down", show=False),
        Binding("k", "cursor_up", "Up", show=False),
        Binding("j", "cursor_down", "Down", show=False),
        Binding("pageup", "page_up", "PgUp", show=False),
        Binding("pagedown", "page_down", "PgDn", show=False),
        Binding("g", "jump_top", "Top", show=False),
        Binding("G", "jump_bottom", "Tail", show=False),
        Binding("e", "toggle_traceback", "Traceback", show=False),
        Binding("f", "quick_filter_row", "Filter Tag", show=False),
    ]

    def __init__(
        self,
        provider: DashboardProvider,
        *,
        initial_log_source: LogSourceId = "live",
        no_color: bool = False,
    ) -> None:
        self._no_color = bool(no_color or os.getenv("NO_COLOR"))
        super().__init__(ansi_color=not self._no_color)
        self.provider = provider
        self.initial_log_source: LogSourceId = (
            initial_log_source if initial_log_source in LOG_SOURCE_ORDER else "live"
        )

        self.connection_state: ConnectionState = "connecting"
        self.snapshot: Optional[ServerSnapshot] = None
        self.breakpoint: ViewportBreakpoint = "medium"
        self.focused_pane: PaneId = "logs"
        self.zoomed_pane: Optional[PaneId] = None
        self.last_api_pid: Optional[int] = None
        self.restart_banner: str = ""
        self.stale: bool = False
        self.exit_code_result: int = 0

        self.header_bar = HeaderBar(
            mode=provider.mode,
            target_label=provider.target_label,
            no_color=self._no_color,
            id="header-bar",
        )
        self.stats_pane = StatsGrid(no_color=self._no_color, id="stats-pane")
        self.checks_pane = ChecksPane(no_color=self._no_color, id="checks-pane")
        self.logs_pane = LogsPane(
            initial_source=self.initial_log_source,
            no_color=self._no_color,
            id="logs-pane",
        )
        self.resize_notice = Static("", id="resize-notice")

    def compose(self) -> ComposeResult:
        yield self.header_bar
        yield self.resize_notice
        with Vertical(id="workspace"):
            yield self.stats_pane
            yield self.checks_pane
            yield self.logs_pane

    async def on_mount(self) -> None:
        self._apply_breakpoint(self.size.width, self.size.height)
        self._apply_focus_classes()
        self.set_interval(1.0, self._check_staleness_tick)
        await self.provider.start(self.handle_provider_event)
        if self.initial_log_source != "live":
            await self.provider.set_log_source(self.initial_log_source)
        self.logs_pane._list.focus()

    async def on_unmount(self) -> None:
        try:
            await self.provider.stop()
        except Exception:
            pass

    def on_resize(self, event: Resize) -> None:
        self._apply_breakpoint(event.size.width, event.size.height)

    def _apply_breakpoint(self, width: int, height: int) -> None:
        bp = compute_breakpoint(width, height)
        self.breakpoint = bp
        for name in ("too-small", "narrow", "medium", "wide"):
            self.screen.remove_class(f"-{name}")
        self.screen.add_class(f"-{bp.replace('_', '-')}")
        if bp == "too_small":
            self.resize_notice.update(
                f"Terminal window too small ({width}x{height}).\n"
                "Please resize to at least 56x14 (80x24+ recommended)."
            )

    def _apply_focus_classes(self) -> None:
        for pane in PANE_ORDER:
            self.screen.remove_class(f"-focus-{pane}")
            self.screen.remove_class(f"-zoom-{pane}")
        self.screen.add_class(f"-focus-{self.focused_pane}")
        if self.zoomed_pane is not None:
            self.screen.add_class(f"-zoom-{self.zoomed_pane}")

    def _check_staleness_tick(self) -> None:
        import time

        if self.snapshot is None:
            return
        is_stale = (time.monotonic() - self.snapshot.received_at_mono) > 6.0
        if is_stale != self.stale:
            self.stale = is_stale
        self.header_bar.update_state(snapshot=self.snapshot, stale=self.stale)

    # --- Provider Event Dispatch ----------------------------------------------------------

    def handle_provider_event(self, event: ProviderEvent) -> None:
        if isinstance(event, SnapshotEvent):
            self.snapshot = event.snapshot
            self.stale = False
            if event.snapshot.api.online and event.snapshot.api.pid is not None:
                if self.last_api_pid is not None and event.snapshot.api.pid != self.last_api_pid:
                    self.restart_banner = f"API restarted (PID {self.last_api_pid} -> {event.snapshot.api.pid})"
                self.last_api_pid = event.snapshot.api.pid
            self.header_bar.update_state(
                snapshot=event.snapshot,
                connection_state=self.connection_state,
                stale=False,
                restart_notice=self.restart_banner,
            )
            self.stats_pane.update_snapshot(event.snapshot)
            self.checks_pane.update_snapshot(event.snapshot)

        elif isinstance(event, ConnectionEvent):
            self.connection_state = event.state
            self.header_bar.update_state(connection_state=event.state)
            if event.detail:
                severity = "warning" if event.state in ("reconnecting", "api_offline_host_live") else "error"
                self.notify(event.detail, severity=severity)

        elif isinstance(event, LogSnapshotEvent):
            if event.pid is not None and self.last_api_pid is not None and event.pid != self.last_api_pid:
                self.restart_banner = f"API restarted (PID {self.last_api_pid} -> {event.pid})"
                self.header_bar.update_state(restart_notice=self.restart_banner)
            if event.pid is not None:
                self.last_api_pid = event.pid
            self.logs_pane.ingest_snapshot(event.source, event.rows, truncated=event.truncated)

        elif isinstance(event, LogRowsEvent):
            self.logs_pane.ingest_rows(event.source, event.rows, truncated=event.truncated)

        elif isinstance(event, LogFilesEvent):
            # Available for future tooltips/badge enrichment
            pass

        elif isinstance(event, NoticeEvent):
            if "API restarted" in event.message:
                self.restart_banner = event.message
                self.header_bar.update_state(restart_notice=self.restart_banner)
            self.notify(event.message, severity=event.severity)

        elif isinstance(event, AuthErrorEvent):
            self.exit_code_result = 2
            self.connection_state = "auth_required"
            self.header_bar.update_state(connection_state="auth_required")
            self.notify(event.detail, title="Authentication Error", severity="error")

    # --- Child Message Handlers -----------------------------------------------------------

    async def on_log_source_changed(self, event: LogSourceChanged) -> None:
        await self.provider.set_log_source(event.source)

    async def on_log_filters_changed(self, event: LogFiltersChanged) -> None:
        await self.provider.set_log_filters(event.filters)

    async def on_log_pause_changed(self, event: LogPauseChanged) -> None:
        await self.provider.set_log_paused(event.paused, event.after_seq)

    def on_check_selected(self, event: CheckSelected) -> None:
        self.logs_pane.set_job_filter(event.job_id)
        self.focused_pane = "logs"
        self._apply_focus_classes()
        self.logs_pane._list.focus()
        self.notify(f"Filtered logs by check {event.job_id[:12]}")

    # --- Interactive Actions & Keybindings ------------------------------------------------

    def _typing_in_input(self) -> bool:
        return isinstance(self.focused, Input)

    def action_quit_dashboard(self) -> None:
        if self._typing_in_input():
            return
        self.exit(self.exit_code_result)

    def action_focus_next_pane(self) -> None:
        idx = PANE_ORDER.index(self.focused_pane)
        self.focused_pane = PANE_ORDER[(idx + 1) % len(PANE_ORDER)]
        self._apply_focus_classes()
        self._focus_active_pane_widget()

    def action_focus_prev_pane(self) -> None:
        idx = PANE_ORDER.index(self.focused_pane)
        self.focused_pane = PANE_ORDER[(idx - 1) % len(PANE_ORDER)]
        self._apply_focus_classes()
        self._focus_active_pane_widget()

    def _focus_active_pane_widget(self) -> None:
        if self.focused_pane == "logs":
            self.logs_pane._list.focus()
        elif self.focused_pane == "checks":
            self.checks_pane._table.focus()
        else:
            self.stats_pane.api_card.focus()

    def action_toggle_zoom(self) -> None:
        if self._typing_in_input():
            return
        self.zoomed_pane = None if self.zoomed_pane == self.focused_pane else self.focused_pane
        self._apply_focus_classes()

    def action_handle_escape(self) -> None:
        if self._typing_in_input():
            self.logs_pane.close_search()
            return
        if self.zoomed_pane is not None:
            self.zoomed_pane = None
            self._apply_focus_classes()

    def action_switch_source(self, index: int) -> None:
        if self._typing_in_input():
            return
        if 0 <= index < len(LOG_SOURCE_ORDER):
            self.logs_pane.set_source(LOG_SOURCE_ORDER[index])

    def action_prev_source(self) -> None:
        if self._typing_in_input():
            return
        self.logs_pane.cycle_source(-1)

    def action_next_source(self) -> None:
        if self._typing_in_input():
            return
        self.logs_pane.cycle_source(1)

    def action_toggle_pause(self) -> None:
        if self._typing_in_input():
            return
        self.logs_pane.toggle_paused()

    def action_focus_search(self) -> None:
        if self._typing_in_input():
            return
        self.focused_pane = "logs"
        self._apply_focus_classes()
        self.logs_pane.focus_search()

    def action_cycle_level(self) -> None:
        if self._typing_in_input():
            return
        lvl = self.logs_pane.cycle_level()
        self.notify(f"Minimum log filter level: {lvl}")

    def action_clear_filters(self) -> None:
        if self._typing_in_input():
            return
        self.logs_pane.clear_filters()
        self.notify("Cleared log filters")

    async def action_refresh_now(self) -> None:
        if self._typing_in_input():
            return
        await self.provider.request_refresh()
        self.notify("Refresh requested")

    def action_cursor_up(self) -> None:
        if self._typing_in_input():
            return
        if self.focused_pane == "checks":
            self.checks_pane.move_selection(-1)
        else:
            self.logs_pane.scroll_step(-1)

    def action_cursor_down(self) -> None:
        if self._typing_in_input():
            return
        if self.focused_pane == "checks":
            self.checks_pane.move_selection(1)
        else:
            self.logs_pane.scroll_step(1)

    def action_page_up(self) -> None:
        if self._typing_in_input():
            return
        if self.focused_pane == "checks":
            self.checks_pane.move_selection(-5)
        else:
            self.logs_pane.scroll_step(-15)

    def action_page_down(self) -> None:
        if self._typing_in_input():
            return
        if self.focused_pane == "checks":
            self.checks_pane.move_selection(5)
        else:
            self.logs_pane.scroll_step(15)

    def action_jump_top(self) -> None:
        if self._typing_in_input():
            return
        self.logs_pane.jump_top()

    def action_jump_bottom(self) -> None:
        if self._typing_in_input():
            return
        self.logs_pane.jump_bottom()

    def action_toggle_traceback(self) -> None:
        if self._typing_in_input():
            return
        self.logs_pane.toggle_selected_traceback()

    def action_quick_filter_row(self) -> None:
        if self._typing_in_input():
            return
        applied = self.logs_pane.quick_filter_selected_row()
        if applied:
            self.notify(f"Filtered logs by {applied}")

    def action_show_help(self) -> None:
        if self._typing_in_input():
            return
        self.push_screen(HelpModal(mode=self.provider.mode, target_label=self.provider.target_label))

    def action_open_actions(self) -> None:
        if self._typing_in_input():
            return
        self.push_screen(ActionsModal(), self._on_action_picked)

    def _on_action_picked(self, req: Optional[ActionRequest]) -> None:
        if req is None:
            return
        if is_disruptive_action(req):
            active_n = len(self.snapshot.active_checks) if self.snapshot else 0
            self.push_screen(
                ConfirmActionModal(req, active_checks=active_n, mode=self.provider.mode),
                lambda res: self._on_confirm_result(req, res),
            )
        else:
            self.run_worker(self._execute_and_report(req))

    def _on_confirm_result(self, req: ActionRequest, result: Optional[tuple[bool, bool]]) -> None:
        if not result or not result[0]:
            return
        confirmed_req = ActionRequest(
            action=req.action,
            service=req.service,
            level=req.level,
            force=bool(result[1]),
        )
        self.run_worker(self._execute_and_report(confirmed_req))

    async def _execute_and_report(self, req: ActionRequest) -> None:
        outcome = await self.provider.execute_action(req)
        if outcome.status_code == 409 and outcome.lost_checks > 0 and not req.force:
            # A check started concurrently between opening modal and submit; escalate to Force prompt.
            self.push_screen(
                ConfirmActionModal(
                    req,
                    active_checks=outcome.lost_checks,
                    mode=self.provider.mode,
                    force_required=True,
                ),
                lambda res: self._on_confirm_result(req, res),
            )
            return
        if outcome.ok:
            self.notify(f"{outcome.summary} ({outcome.ms}ms)", title=req.action)
        else:
            self.notify(outcome.summary, title=f"{req.action} failed", severity="error")
