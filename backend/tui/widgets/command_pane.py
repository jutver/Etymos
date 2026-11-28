"""Toggleable integrated bottom CommandPane with live streaming output and history recall."""
from __future__ import annotations

from collections import deque
from typing import Optional

from rich.text import Text
from textual.containers import Horizontal, Vertical
from textual.events import Key
from textual.message import Message
from textual.widgets import Input, RichLog, Static

from ..models import (
    CommandHistory,
    CommandStatus,
    OperatingMode,
    RemoteExecCapability,
)
from ..providers.base import CommandDoneEvent, CommandOutputEvent, CommandStartedEvent
from ..sanitize import sanitize_log_text


class CommandSubmitted(Message):
    def __init__(self, command: str) -> None:
        super().__init__()
        self.command = command


class CommandCancelRequested(Message):
    def __init__(self, run_id: str) -> None:
        super().__init__()
        self.run_id = run_id


class _CommandPromptInput(Input):
    """Input widget adding Up/Down CommandHistory navigation with draft preservation."""

    def __init__(self, pane: "CommandPane", **kwargs) -> None:
        super().__init__(**kwargs)
        self._pane = pane

    def on_key(self, event: Key) -> None:
        if event.key == "up":
            recalled = self._pane.history.step_up(self.value)
            if recalled is not None:
                self.value = recalled
                self.cursor_position = len(recalled)
            event.prevent_default()
            event.stop()
        elif event.key == "down":
            recalled = self._pane.history.step_down()
            if recalled is not None:
                self.value = recalled
                self.cursor_position = len(recalled)
            event.prevent_default()
            event.stop()


class CommandPane(Vertical):
    """Integrated command execution workspace available consistently in Remote & Local modes."""

    def __init__(self, *, mode: OperatingMode = "local", no_color: bool = False, **kwargs) -> None:
        super().__init__(**kwargs)
        self._mode = mode
        self._no_color = no_color
        self.is_open = False
        self.status: CommandStatus = "idle"
        self.active_run_id: Optional[str] = None
        self.last_exit_code: Optional[int] = None
        self.last_duration_ms: Optional[int] = None
        self.capability: Optional[RemoteExecCapability] = None
        self.history = CommandHistory()
        self.transcript_lines: deque[str] = deque(maxlen=2000)

        self._header = Static(id="cmd-header")
        self._output = RichLog(max_lines=2000, markup=False, highlight=False, auto_scroll=True, id="cmd-output")
        self._prompt_label = Static("$", id="cmd-prompt-label")
        self._input = _CommandPromptInput(
            self,
            placeholder="Command (e.g. $SV status, nvidia-smi, df -h) — Enter run · ↑/↓ history · Esc blur",
            id="cmd-input",
        )

    def compose(self):
        yield self._header
        yield self._output
        with Horizontal(id="cmd-input-row"):
            yield self._prompt_label
            yield self._input

    def on_mount(self) -> None:
        self._refresh_header()

    # --- Open/Close & Focus Helpers -------------------------------------------------------

    def set_open(self, opened: bool) -> None:
        self.is_open = bool(opened)
        if self.is_open:
            self.focus_prompt()
        self._refresh_header()

    def focus_prompt(self) -> None:
        self._input.focus()

    def focus_transcript(self) -> None:
        self._output.focus()

    def scroll_transcript(self, delta: int) -> None:
        target = max(0.0, float(self._output.scroll_y) + delta)
        self._output.scroll_to(y=target, animate=False, immediate=True)

    def update_capability(self, cap: Optional[RemoteExecCapability]) -> None:
        self.capability = cap
        self._refresh_header()

    def clear_output(self) -> None:
        self.transcript_lines.clear()
        self._output.clear()
        if self.status != "running":
            self.status = "idle"
            self.last_exit_code = None
            self.last_duration_ms = None
            self._refresh_header()

    # --- Execution Lifecycle --------------------------------------------------------------

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input is not self._input:
            return
        event.stop()
        raw = self._input.value
        cleaned = raw.strip()
        if not cleaned:
            return
        if self.status == "running":
            self._append_system_line("Another command is still running (press Ctrl+X or Ctrl+C to cancel).", style="yellow")
            return
        if len(cleaned) > 2000:
            self._append_system_line("Command exceeds maximum length of 2000 characters.", style="bold red")
            return
        self.history.push(cleaned)
        self._input.value = ""
        self.post_message(CommandSubmitted(cleaned))

    def begin_run(self, run_id: str, command: str) -> None:
        self.active_run_id = run_id
        self.status = "running"
        self.last_exit_code = None
        self.last_duration_ms = None
        self._output.auto_scroll = True
        self._append_system_line(f"$ {sanitize_log_text(command, preserve_newlines=False)}", style="bold cyan")
        self._refresh_header()

    def handle_started(self, event: CommandStartedEvent) -> None:
        if self.active_run_id and event.run_id != self.active_run_id:
            return
        if event.cwd:
            self._append_system_line(f"cwd: {event.cwd}", style="dim")

    def append_output(self, event: CommandOutputEvent) -> None:
        if self.active_run_id and event.run_id != self.active_run_id:
            return
        clean = sanitize_log_text(event.data, preserve_newlines=True)
        if not clean:
            return
        style = ""
        if not self._no_color:
            if event.stream == "stderr":
                style = "red"
            elif event.stream == "system":
                style = "yellow"
        lines = clean.splitlines()
        if not lines:
            lines = [clean]
        for ln in lines:
            self.transcript_lines.append(ln)
            self._output.write(Text(ln, style=style), scroll_end=True)

    def finish_run(self, event: CommandDoneEvent) -> None:
        if self.active_run_id and event.run_id != self.active_run_id:
            return
        self.active_run_id = None
        self.status = event.status
        self.last_exit_code = event.exit_code
        self.last_duration_ms = event.duration_ms
        if event.truncated:
            self._append_system_line("[OUTPUT TRUNCATED AT CAP]", style="bold yellow")
        if event.error:
            self._append_system_line(event.error, style="bold red" if event.status in ("denied", "disabled", "disconnected") else "yellow")
        else:
            rc_str = f"exit {event.exit_code}" if event.exit_code is not None else event.status
            self._append_system_line(f"[{event.status.upper()} · {rc_str} · {event.duration_ms}ms]", style="dim cyan")
        self._refresh_header()

    def _append_system_line(self, line: str, *, style: str = "dim") -> None:
        clean = sanitize_log_text(line, preserve_newlines=False)
        self.transcript_lines.append(clean)
        self._output.write(Text(clean, style="" if self._no_color else style), scroll_end=True)

    def _refresh_header(self) -> None:
        out = Text()
        out.append(" CMD ", style="bold reverse" if self._no_color else "bold black on bright_cyan")
        if self._mode == "local":
            out.append("  EXEC: LOCAL", style="bold" if self._no_color else "bold green")
        elif self.capability is not None and self.capability.enabled:
            out.append("  EXEC: ENABLED", style="bold" if self._no_color else "bold green")
        else:
            out.append("  EXEC: DISABLED", style="bold" if self._no_color else "bold yellow")

        out.append("  |  ")
        if self.status == "running":
            out.append("● RUNNING…", style="bold" if self._no_color else "bold yellow")
        elif self.status == "completed":
            ms = self.last_duration_ms or 0
            out.append(f"OK · exit {self.last_exit_code if self.last_exit_code is not None else 0} · {ms}ms", style="bold" if self._no_color else "bold green")
        elif self.status == "idle":
            out.append("IDLE", style="dim")
        elif self.status in ("disabled", "denied", "disconnected", "timed_out", "failed"):
            rc = f"exit {self.last_exit_code} · " if self.last_exit_code is not None else ""
            out.append(f"{self.status.upper()} · {rc}{self.last_duration_ms or 0}ms", style="bold" if self._no_color else "bold red")
        elif self.status == "cancelled":
            out.append(f"CANCELLED · {self.last_duration_ms or 0}ms", style="bold" if self._no_color else "bold yellow")

        out.append("  |  [:/x]Toggle [z]Zoom [Ctrl+X]Cancel [Ctrl+L]Clear [↑/↓]Hist", style="" if self._no_color else "dim")
        self._header.update(out)
