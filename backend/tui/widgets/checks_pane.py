"""ChecksPane: active and recently finished verification checks with drill-down."""
from __future__ import annotations

from typing import Optional

from rich.text import Text
from textual.containers import Vertical
from textual.message import Message
from textual.widgets import DataTable, Static

from ..models import ServerSnapshot, VerificationCheck
from ..sanitize import format_iso_local, format_seconds, sanitize_log_text, short_job, truncate_middle


class CheckSelected(Message):
    """Emitted when the operator presses Enter on a check row to filter logs."""

    def __init__(self, job_id: str) -> None:
        super().__init__()
        self.job_id = job_id


class ChecksPane(Vertical):
    """Displays Checks Running Now and Recently Finished Checks cleanly."""

    def __init__(self, *, no_color: bool = False, **kwargs) -> None:
        super().__init__(**kwargs)
        self._no_color = no_color
        self._header = Static(id="checks-header")
        self._empty_active = Static("No checks are running.", id="checks-empty-active")
        self._empty_recent = Static("No checks have finished since the API started.", id="checks-empty-recent")
        self._table = DataTable(cursor_type="row", id="checks-table")
        self._row_job_ids: list[str] = []

    def compose(self):
        yield self._header
        yield self._empty_active
        yield self._empty_recent
        yield self._table

    def on_mount(self) -> None:
        self._table.add_columns("Group", "Check", "File", "Status", "Step / Detail", "Time", "User")
        self._table.display = False
        self._refresh_header(0, 0)

    def _refresh_header(self, active_n: int, recent_n: int) -> None:
        txt = Text()
        txt.append("Verification checks ", style="bold" if self._no_color else "bold cyan")
        txt.append(
            f"(Running: {active_n} · Recent: {recent_n})   [Enter] Filter logs by check",
            style="" if self._no_color else "dim",
        )
        self._header.update(txt)

    def update_snapshot(self, snapshot: ServerSnapshot) -> None:
        active = snapshot.active_checks
        recent = snapshot.recent_checks
        self._refresh_header(len(active), len(recent))

        self._empty_active.display = len(active) == 0
        self._empty_recent.display = len(recent) == 0

        combined: list[tuple[str, VerificationCheck]] = [("NOW", c) for c in active] + [
            ("DONE", c) for c in recent
        ]
        prev_row = self._table.cursor_row if self._table.row_count else 0

        self._table.clear(columns=False)
        self._row_job_ids = []

        if not combined:
            self._table.display = False
            return

        self._table.display = True
        for group_label, chk in combined:
            self._row_job_ids.append(chk.job_id)
            file_col = f"{truncate_middle(chk.input_name or '—', 22)} [{chk.input_type.upper()}]"

            if chk.status == "processing":
                status_str = f"RUN {chk.progress}%"
                status_style = "" if self._no_color else "cyan"
            elif chk.status == "completed":
                status_str = "DONE"
                status_style = "" if self._no_color else "green"
            elif chk.status == "failed":
                status_str = "FAILED"
                status_style = "bold" if self._no_color else "bold red"
            else:
                status_str = "QUEUED"
                status_style = "" if self._no_color else "yellow"

            detail = chk.error if (chk.status == "failed" and chk.error) else chk.message
            step_col = f"{chk.current_step}: {truncate_middle(detail, 34)}" if detail else chk.current_step
            if chk.status in ("queued", "processing"):
                time_col = f"{format_seconds(chk.age_seconds)} ({format_seconds(chk.step_seconds)})"
            else:
                time_col = format_iso_local(chk.updated_at)[-8:]
            user_col = sanitize_log_text(chk.user_id[:8], preserve_newlines=False) if chk.user_id else "—"

            self._table.add_row(
                group_label,
                short_job(chk.job_id),
                file_col,
                Text(status_str, style=status_style),
                Text(sanitize_log_text(step_col, preserve_newlines=False), style="red" if (not self._no_color and chk.status == "failed") else ""),
                time_col,
                user_col,
            )

        if self._table.row_count > 0:
            self._table.move_cursor(row=min(prev_row, self._table.row_count - 1))

    def move_selection(self, delta: int) -> None:
        if not self._table.row_count:
            return
        cur = self._table.cursor_row or 0
        nxt = max(0, min(self._table.row_count - 1, cur + delta))
        self._table.move_cursor(row=nxt)

    def select_highlighted(self) -> Optional[str]:
        if not self._table.row_count:
            return None
        row = self._table.cursor_row
        if row is None or row < 0 or row >= len(self._row_job_ids):
            return None
        job_id = self._row_job_ids[row]
        self.post_message(CheckSelected(job_id))
        return job_id

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        if event.data_table is not self._table:
            return
        idx = event.cursor_row
        if 0 <= idx < len(self._row_job_ids):
            self.post_message(CheckSelected(self._row_job_ids[idx]))
            event.stop()
