"""Reactive LogsPane: source tabs (1-8), filters, 20Hz coalesced flush, pause, and tracebacks."""
from __future__ import annotations

from contextlib import contextmanager
import logging
from typing import Iterator, Optional

from rich.text import Text
from textual.containers import Vertical
from textual.message import Message
from textual.widgets import Input, OptionList, Static
from textual.widgets.option_list import Option

from ..models import (
    LOG_LEVELS,
    LOG_SOURCE_LABELS,
    LOG_SOURCE_ORDER,
    LogEntry,
    LogFilterState,
    LogLevel,
    LogScrollState,
    LogSourceId,
    LogStore,
    parse_search_query,
)
from ..sanitize import sanitize_log_text, short_job

LEVEL_SHORT: dict[str, tuple[str, str]] = {
    "DEBUG": ("DBG", "dim white"),
    "INFO": ("INF", "cyan"),
    "WARNING": ("WRN", "bold yellow"),
    "ERROR": ("ERR", "bold red"),
    "CRITICAL": ("CRT", "bold white on red"),
    "RAW": ("RAW", "dim cyan"),
}


class LogSourceChanged(Message):
    def __init__(self, source: LogSourceId) -> None:
        super().__init__()
        self.source = source


class LogFiltersChanged(Message):
    def __init__(self, filters: LogFilterState) -> None:
        super().__init__()
        self.filters = filters


class LogPauseChanged(Message):
    def __init__(self, paused: bool, after_seq: int) -> None:
        super().__init__()
        self.paused = paused
        self.after_seq = after_seq


class _ScrollAwareLogList(OptionList):
    """OptionList subclass that auto-pauses LogsPane on any upward user scroll."""

    def __init__(self, pane: "LogsPane", **kwargs) -> None:
        super().__init__(**kwargs)
        self._pane = pane

    def watch_scroll_y(self, old_value: float, new_value: float) -> None:
        parent_watch = getattr(super(), "watch_scroll_y", None)
        if callable(parent_watch):
            parent_watch(old_value, new_value)
        state = self._pane.scroll_state
        state.scroll_y = max(0.0, float(new_value))
        if state.programmatic_guard:
            return
        max_y = float(self.max_scroll_y)
        if max_y <= 0.5:
            return
        if new_value < old_value - 0.1 and new_value < max_y - 1.0:
            if not self._pane.paused:
                self._pane.toggle_paused(force=True)
        elif self._pane.paused and new_value > old_value + 0.1 and new_value >= max_y - 0.5:
            self._pane.toggle_paused(force=False)


class LogsPane(Vertical):
    """Multi-source log viewer with bounded ring buffer, filters, pause, and traceback expand."""

    def __init__(self, *, initial_source: LogSourceId = "live", no_color: bool = False, **kwargs) -> None:
        super().__init__(**kwargs)
        self._no_color = no_color
        self.selected_source: LogSourceId = initial_source if initial_source in LOG_SOURCE_ORDER else "live"
        self.filters = LogFilterState()
        self.store = LogStore(capacity=3000)
        self.scroll_state = LogScrollState(source=self.selected_source)
        self.paused = False
        self.unread_while_paused = 0
        self.truncated_notice = False
        self.expanded_tracebacks: set[str] = set()

        self._displayed: list[LogEntry] = []
        self._pending_reset = False
        self._pending_rows: list[LogEntry] = []
        self._last_highlighted_idx: Optional[int] = None

        self._tabs_bar = Static(id="logs-tabs")
        self._status_bar = Static(id="logs-filter-bar")
        self._search_input = Input(
            placeholder="Filter logs (text or job:<id> req:<id> user:<id>, Enter apply, Esc close)",
            id="log-search-input",
        )
        self._list = _ScrollAwareLogList(self, id="logs-list")
        self._empty_hint = Static("Waiting for log entries…", id="logs-empty")

    def compose(self):
        yield self._tabs_bar
        yield self._status_bar
        yield self._search_input
        yield self._empty_hint
        yield self._list

    def on_mount(self) -> None:
        self._search_input.display = False
        self._empty_hint.display = True
        self._list.display = True
        self.set_interval(0.05, self._flush_pending)
        self._refresh_chrome()

    @contextmanager
    def _programmatic_scroll(self) -> Iterator[None]:
        prev = self.scroll_state.programmatic_guard
        self.scroll_state.programmatic_guard = True
        try:
            yield
        finally:
            self.scroll_state.programmatic_guard = prev
            self.scroll_state.scroll_y = max(0.0, float(self._list.scroll_y))

    def _sync_scroll_state_flags(self) -> None:
        self.scroll_state.source = self.selected_source
        self.scroll_state.paused = self.paused
        self.scroll_state.unread_while_paused = self.unread_while_paused
        self.scroll_state.scroll_y = max(0.0, float(self._list.scroll_y))

    def _scroll_to_tail_programmatic(self) -> None:
        if not self._displayed:
            return
        with self._programmatic_scroll():
            self._list.highlighted = len(self._displayed) - 1
            self._list.scroll_end(animate=False)
            self._last_highlighted_idx = self._list.highlighted
            self.scroll_state.highlighted_key = self._displayed[-1].key

        def _after_refresh_tail() -> None:
            if self.paused or not self._displayed:
                return
            with self._programmatic_scroll():
                self._list.scroll_end(animate=False)

        self.call_after_refresh(_after_refresh_tail)

    # --- Source, Filter, & Pause Controls -------------------------------------------------

    def set_source(self, source: LogSourceId) -> None:
        if source not in LOG_SOURCE_ORDER or source == self.selected_source:
            return
        was_paused = self.paused
        self.selected_source = source
        self.paused = False
        self.unread_while_paused = 0
        self.truncated_notice = False
        self.scroll_state.source = source
        self.scroll_state.paused = False
        self.scroll_state.unread_while_paused = 0
        self.scroll_state.scroll_y = 0.0
        self.scroll_state.highlighted_key = None
        self._last_highlighted_idx = None
        self.store.clear()
        self._pending_rows.clear()
        self._pending_reset = True
        self._flush_pending()
        if was_paused:
            self.post_message(LogPauseChanged(False, 0))
        self.post_message(LogSourceChanged(source))

    def cycle_source(self, step: int) -> None:
        idx = LOG_SOURCE_ORDER.index(self.selected_source)
        next_idx = (idx + step) % len(LOG_SOURCE_ORDER)
        self.set_source(LOG_SOURCE_ORDER[next_idx])

    def cycle_level(self) -> LogLevel:
        idx = LOG_LEVELS.index(self.filters.min_level)
        next_level = LOG_LEVELS[(idx + 1) % len(LOG_LEVELS)]
        self.apply_filters(
            LogFilterState(
                min_level=next_level,
                q=self.filters.q,
                job=self.filters.job,
                request=self.filters.request,
                user_id=self.filters.user_id,
            )
        )
        return next_level

    def set_job_filter(self, job_id: str) -> None:
        if self.selected_source != "live":
            self.set_source("live")
        self.apply_filters(
            LogFilterState(
                min_level=self.filters.min_level,
                q=self.filters.q,
                job=job_id,
                request="",
                user_id="",
            )
        )

    def quick_filter_selected_row(self) -> Optional[str]:
        """Filter by highlighted row's `job`, `request`, or `user` tag (FR-008)."""
        idx = self._list.highlighted
        if idx is None or idx < 0 or idx >= len(self._displayed):
            return None
        entry = self._displayed[idx]
        if entry.job:
            self.apply_filters(
                LogFilterState(
                    min_level=self.filters.min_level,
                    q=self.filters.q,
                    job=entry.job,
                    request="",
                    user_id="",
                )
            )
            return f"job:{short_job(entry.job)}"
        if entry.request:
            self.apply_filters(
                LogFilterState(
                    min_level=self.filters.min_level,
                    q=self.filters.q,
                    job="",
                    request=entry.request,
                    user_id="",
                )
            )
            return f"req:{entry.request}"
        if entry.user:
            self.apply_filters(
                LogFilterState(
                    min_level=self.filters.min_level,
                    q=self.filters.q,
                    job="",
                    request="",
                    user_id=entry.user,
                )
            )
            return f"user:{entry.user[:8]}"
        return None

    def clear_filters(self) -> None:
        self._search_input.value = ""
        self.apply_filters(LogFilterState())

    def apply_filters(self, next_filters: LogFilterState) -> None:
        self.filters = next_filters
        self._rebuild_visible_list(scroll_to_end=not self.paused)
        self._refresh_chrome()
        self.post_message(LogFiltersChanged(self.filters))

    def focus_search(self) -> None:
        self._search_input.display = True
        self._search_input.focus()

    def close_search(self) -> None:
        if not self._search_input.value.strip():
            self._search_input.display = False
        self._list.focus()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input is not self._search_input:
            return
        self._apply_search_text(event.value)
        self.close_search()
        event.stop()

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input is not self._search_input:
            return
        self._apply_search_text(event.value)
        event.stop()

    def _apply_search_text(self, raw: str) -> None:
        free_q, parsed_tags = parse_search_query(raw)
        next_filters = LogFilterState(
            min_level=self.filters.min_level,
            q=free_q,
            job=parsed_tags.get("job", self.filters.job if not raw.strip() else parsed_tags.get("job", "")),
            request=parsed_tags.get("request", self.filters.request if not raw.strip() else parsed_tags.get("request", "")),
            user_id=parsed_tags.get("user_id", self.filters.user_id if not raw.strip() else parsed_tags.get("user_id", "")),
        )
        # If query has no inline tag override, preserve chip filters explicitly set via Enter/f
        if not parsed_tags:
            next_filters.job = self.filters.job
            next_filters.request = self.filters.request
            next_filters.user_id = self.filters.user_id
        self.apply_filters(next_filters)

    def toggle_paused(self, *, force: Optional[bool] = None) -> bool:
        next_paused = (not self.paused) if force is None else bool(force)
        if next_paused == self.paused:
            return self.paused
        self.paused = next_paused
        if not self.paused:
            self.unread_while_paused = 0
            if self._displayed:
                self._scroll_to_tail_programmatic()
        self._sync_scroll_state_flags()
        self._refresh_chrome()
        self.post_message(LogPauseChanged(self.paused, self.store.last_seq))
        return self.paused

    def jump_top(self) -> None:
        if not self._displayed:
            return
        if not self.paused:
            self.toggle_paused(force=True)
        with self._programmatic_scroll():
            self._list.highlighted = 0
            self._list.scroll_home(animate=False)
            self._last_highlighted_idx = 0
            self.scroll_state.highlighted_key = self._displayed[0].key

    def jump_bottom(self) -> None:
        self.toggle_paused(force=False)
        if self._displayed:
            self._scroll_to_tail_programmatic()

    def scroll_step(self, delta: int) -> None:
        if not self._displayed:
            return
        cur = self._list.highlighted
        if cur is None:
            cur = len(self._displayed) - 1
        nxt = max(0, min(len(self._displayed) - 1, cur + delta))
        if delta < 0 and nxt < len(self._displayed) - 1 and not self.paused:
            self.toggle_paused(force=True)
        with self._programmatic_scroll():
            self._list.highlighted = nxt
            self._list.scroll_to_highlight()
            self._last_highlighted_idx = nxt
            self.scroll_state.highlighted_key = self._displayed[nxt].key

    def on_option_list_option_highlighted(self, event: OptionList.OptionHighlighted) -> None:
        if event.option_list is not self._list:
            return
        idx = event.option_index
        if 0 <= idx < len(self._displayed):
            self.scroll_state.highlighted_key = self._displayed[idx].key
        if not self.scroll_state.programmatic_guard and self._displayed:
            moved_up = self._last_highlighted_idx is not None and idx < self._last_highlighted_idx
            moved_down = self._last_highlighted_idx is not None and idx > self._last_highlighted_idx
            max_y = float(self._list.max_scroll_y)
            cur_y = float(self._list.scroll_y)
            if idx < len(self._displayed) - 1 and not self.paused:
                away_from_bottom = max_y > 0.5 and cur_y < max_y - 1.0
                if moved_up or away_from_bottom:
                    self.toggle_paused(force=True)
            elif self.paused and moved_down and idx == len(self._displayed) - 1 and (max_y <= 0.5 or cur_y >= max_y - 0.5):
                self.toggle_paused(force=False)
        self._last_highlighted_idx = idx

    def toggle_selected_traceback(self) -> bool:
        idx = self._list.highlighted
        if idx is None or idx < 0 or idx >= len(self._displayed):
            return False
        entry = self._displayed[idx]
        if not entry.exc:
            return False
        if entry.key in self.expanded_tracebacks:
            self.expanded_tracebacks.remove(entry.key)
        else:
            self.expanded_tracebacks.add(entry.key)
        self._list.replace_option_prompt_at_index(idx, self._render_entry(entry))
        return True

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        if event.option_list is self._list:
            self.toggle_selected_traceback()
            event.stop()

    # --- Stream Ingestion & 20Hz Coalesced Flush ------------------------------------------

    def ingest_snapshot(
        self,
        source: LogSourceId,
        rows: list[LogEntry],
        *,
        truncated: bool = False,
        reset_pause: bool = False,
    ) -> None:
        if source != self.selected_source:
            return
        if reset_pause and self.paused:
            self.paused = False
            self.unread_while_paused = 0
            self._sync_scroll_state_flags()
        self.truncated_notice = truncated
        self._pending_rows.clear()
        self._pending_reset = True
        self._pending_rows.extend(rows)
        self.flush_now()

    def ingest_rows(
        self,
        source: LogSourceId,
        rows: list[LogEntry],
        *,
        truncated: bool = False,
    ) -> None:
        if source != self.selected_source:
            return
        if truncated:
            self.truncated_notice = True
        if rows:
            self._pending_rows.extend(rows)

    def flush_now(self) -> None:
        self._flush_pending()

    def _flush_pending(self) -> None:
        if not self._pending_reset and not self._pending_rows:
            return
        do_reset = self._pending_reset
        batch = self._pending_rows[:]
        self._pending_rows.clear()
        self._pending_reset = False

        if do_reset:
            self.store.replace_all(batch)
            self._rebuild_visible_list(scroll_to_end=not self.paused)
            self._refresh_chrome()
            return

        before_dropped = self.store.dropped_count
        added = self.store.extend(batch)
        if not added:
            return

        matched = [entry for entry in added if self.store.matches(entry, self.filters)]
        if self.paused and matched:
            self.unread_while_paused += len(matched)
            self._sync_scroll_state_flags()

        # If oldest rows were evicted past 3000 capacity, rebuild displayed list cleanly.
        if self.store.dropped_count != before_dropped:
            self._rebuild_visible_list(scroll_to_end=not self.paused)
            self._refresh_chrome()
            return

        if not matched:
            self._refresh_chrome()
            return

        self._append_visible_entries(matched)
        if not self.paused and self._displayed:
            self._scroll_to_tail_programmatic()
        self._refresh_chrome()

    def _rebuild_visible_list(self, *, scroll_to_end: bool) -> None:
        saved_y = max(0.0, float(self._list.scroll_y))
        saved_key: Optional[str] = None
        cur_idx = self._list.highlighted
        if cur_idx is not None and 0 <= cur_idx < len(self._displayed):
            saved_key = self._displayed[cur_idx].key

        matched = self.store.filtered(self.filters)
        self._displayed = matched
        with self._programmatic_scroll():
            self._list.clear_options()
            if matched:
                self._empty_hint.display = False
                self._list.add_options([Option(self._render_entry(e), id=e.key) for e in matched])
            else:
                self._empty_hint.update(
                    "No log lines match active filters."
                    if self.filters.has_active_filters()
                    else f"Waiting for {self.selected_source} log lines…"
                )
                self._empty_hint.display = True

        if not matched:
            self._last_highlighted_idx = None
            return

        if scroll_to_end:
            self._scroll_to_tail_programmatic()
            return

        # Restore reading position cleanly without snapping to the bottom.
        key_index = {e.key: i for i, e in enumerate(matched)}
        target_y = 0.0
        target_idx: Optional[int] = None
        if saved_key and saved_key in key_index:
            target_idx = key_index[saved_key]
            target_y = min(saved_y, float(self._list.max_scroll_y))
        elif saved_key:
            # Rotation/reset replaced prior entries: reload cleanly near top without jumping to tail.
            target_idx = 0
            target_y = 0.0

        with self._programmatic_scroll():
            if target_idx is not None:
                self._list.highlighted = target_idx
                self._last_highlighted_idx = target_idx
                self.scroll_state.highlighted_key = matched[target_idx].key
            self._list.scroll_to(y=target_y, animate=False, immediate=True)

        def _after_refresh_restore() -> None:
            if not self.paused or not self._displayed:
                return
            with self._programmatic_scroll():
                bounded_y = min(target_y, float(self._list.max_scroll_y))
                self._list.scroll_to(y=bounded_y, animate=False, immediate=True)

        self.call_after_refresh(_after_refresh_restore)

    def _append_visible_entries(self, entries: list[LogEntry]) -> None:
        if not entries:
            return
        prev_y = max(0.0, float(self._list.scroll_y))
        self._displayed.extend(entries)
        self._empty_hint.display = False
        with self._programmatic_scroll():
            self._list.add_options([Option(self._render_entry(e), id=e.key) for e in entries])
            if self.paused:
                self._list.scroll_to(y=min(prev_y, float(self._list.max_scroll_y)), animate=False, immediate=True)

    # --- Chrome & Entry Rendering ---------------------------------------------------------

    def _refresh_chrome(self) -> None:
        tabs = Text()
        for idx, src in enumerate(LOG_SOURCE_ORDER, 1):
            label = f" {idx}:{LOG_SOURCE_LABELS[src]} "
            active = src == self.selected_source
            if self._no_color:
                tabs.append(f"[{label.strip()}]" if active else label, style="bold reverse" if active else "")
            else:
                tabs.append(label, style="bold black on bright_cyan" if active else "dim white")
            tabs.append(" ")
        self._tabs_bar.update(tabs)

        bar = Text()
        if self.paused:
            unread = f" ({self.unread_while_paused} new)" if self.unread_while_paused else ""
            bar.append(f"⏸ PAUSED{unread}", style="bold" if self._no_color else "bold yellow")
        elif self.selected_source == "live":
            bar.append("● STREAMING", style="bold" if self._no_color else "bold green")
        else:
            bar.append(f"● FILE TAIL ({self.selected_source})", style="bold" if self._no_color else "bold cyan")

        bar.append(f"  |  Level>={self.filters.min_level}", style="" if self._no_color else "dim white")
        if self.filters.q:
            bar.append(f"  q={self.filters.q!r}", style="bold" if self._no_color else "bold white")
        if self.filters.job:
            bar.append(f"  job={short_job(self.filters.job)}", style="bold" if self._no_color else "bold magenta")
        if self.filters.request:
            bar.append(f"  req={self.filters.request}", style="bold" if self._no_color else "bold cyan")
        if self.filters.user_id:
            bar.append(f"  user={self.filters.user_id[:8]}", style="bold" if self._no_color else "bold cyan")

        if self.truncated_notice:
            bar.append("  [TRUNCATED: older lines skipped]", style="bold" if self._no_color else "bold yellow")

        bar.append(
            f"  |  {len(self._displayed)}/{len(self.store)} rows  [/]Search [l]Level [p]Pause [e]Trace [f]Tag [c]Clear",
            style="" if self._no_color else "dim",
        )
        self._status_bar.update(bar)

    def _render_entry(self, entry: LogEntry) -> Text:
        out = Text()
        short_lbl, lvl_style = LEVEL_SHORT.get(entry.level, ("INF", "white"))
        out.append(f"{entry.ts_text} ", style="" if self._no_color else "dim")
        out.append(f"{short_lbl:<4}", style="bold" if self._no_color else lvl_style)

        if entry.job:
            out.append(f"[{short_job(entry.job)}] ", style="" if self._no_color else "magenta")
        elif entry.request:
            out.append(f"[r:{entry.request}] ", style="" if self._no_color else "cyan")
        if entry.user:
            out.append(f"u:{entry.user[:8]} ", style="" if self._no_color else "dim")

        if entry.logger and entry.logger != "-":
            out.append(f"{entry.logger}: ", style="" if self._no_color else "dim white")

        msg_style = ""
        if not self._no_color:
            if entry.level in ("ERROR", "CRITICAL"):
                msg_style = "red"
            elif entry.level == "WARNING":
                msg_style = "yellow"
        out.append(sanitize_log_text(entry.message, preserve_newlines=False), style=msg_style)

        if entry.exc:
            if entry.key in self.expanded_tracebacks:
                out.append("\n")
                for line in sanitize_log_text(entry.exc, preserve_newlines=True).splitlines():
                    out.append(f"    {line}\n", style="" if self._no_color else "dim red")
            else:
                out.append("  [▸ traceback: press Enter/e]", style="bold" if self._no_color else "bold red")
        return out
