"""Modal screens: Operational Actions Menu, Guarded Confirm Dialog, and Help Overlay."""
from __future__ import annotations

from typing import Optional

from rich.text import Text
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, OptionList, Static
from textual.widgets.option_list import Option

from ..command_safety import DestructiveMatch
from ..models import ActionRequest, OperatingMode
from ..sanitize import sanitize_log_text

_MENU_OPTIONS: list[tuple[str, ActionRequest]] = [
    ("Runtime: Set API Log Level -> DEBUG", ActionRequest(action="log-level", level="DEBUG")),
    ("Runtime: Set API Log Level -> INFO", ActionRequest(action="log-level", level="INFO")),
    ("Runtime: Set API Log Level -> WARNING", ActionRequest(action="log-level", level="WARNING")),
    ("Runtime: Set API Log Level -> ERROR", ActionRequest(action="log-level", level="ERROR")),
    ("Runtime: Write All Thread Stacks to Log (dump-threads)", ActionRequest(action="dump-threads")),
    ("Runtime: Unload Idle GPU Models (free-gpu)", ActionRequest(action="free-gpu")),
    ("Runtime: Send Due Notifications Now (run-notifications)", ActionRequest(action="run-notifications")),
    ("Runtime: Poll Support Inbox Now (poll-support-inbox)", ActionRequest(action="poll-support-inbox")),
    ("Service [etymos-api]: Restart API", ActionRequest(action="restart-service", service="etymos-api")),
    ("Service [etymos-api]: Start API", ActionRequest(action="start-service", service="etymos-api")),
    ("Service [etymos-api]: Stop API", ActionRequest(action="stop-service", service="etymos-api")),
    ("Service [cloudflared]: Restart Tunnel", ActionRequest(action="restart-service", service="cloudflared")),
    ("Service [cloudflared]: Start Tunnel", ActionRequest(action="start-service", service="cloudflared")),
    ("Service [cloudflared]: Stop Tunnel", ActionRequest(action="stop-service", service="cloudflared")),
    ("Service [etymos-deploy]: Restart Auto-Deploy", ActionRequest(action="restart-service", service="etymos-deploy")),
    ("Service [etymos-deploy]: Start Auto-Deploy", ActionRequest(action="start-service", service="etymos-deploy")),
    ("Service [etymos-deploy]: Stop Auto-Deploy", ActionRequest(action="stop-service", service="etymos-deploy")),
]


def is_disruptive_action(req: ActionRequest) -> bool:
    return req.action in ("restart-api", "shutdown-api", "restart-service", "stop-service")


class ActionsModal(ModalScreen[Optional[ActionRequest]]):
    """Allowlisted server action picker (never exposes arbitrary shell input)."""

    BINDINGS = [
        Binding("escape", "cancel", "Close"),
        Binding("q", "cancel", "Close"),
    ]

    def compose(self):
        with Vertical(id="modal-dialog", classes="modal-box"):
            yield Static("Server Operational Actions  (Enter select · Esc cancel)", classes="modal-title")
            opts = OptionList(*[Option(label, id=f"act-{idx}") for idx, (label, _) in enumerate(_MENU_OPTIONS)], id="actions-list")
            yield opts
            with Horizontal(classes="modal-buttons"):
                yield Button("Run Selected", variant="primary", id="btn-run-selected")
                yield Button("Cancel", id="btn-cancel-actions")

    def on_mount(self) -> None:
        self.query_one("#actions-list", OptionList).focus()

    def action_cancel(self) -> None:
        self.dismiss(None)

    def _submit_highlighted(self) -> None:
        lst = self.query_one("#actions-list", OptionList)
        idx = lst.highlighted
        if idx is not None and 0 <= idx < len(_MENU_OPTIONS):
            self.dismiss(_MENU_OPTIONS[idx][1])

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        if event.option_list.id == "actions-list":
            self._submit_highlighted()
            event.stop()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-run-selected":
            self._submit_highlighted()
        else:
            self.dismiss(None)


class ConfirmActionModal(ModalScreen[tuple[bool, bool]]):
    """Explicit confirmation + active-check force guard for restart/stop actions.

    Returns `(confirmed, force)`.
    """

    BINDINGS = [
        Binding("escape", "cancel", "Cancel"),
        Binding("n", "cancel", "Cancel"),
    ]

    def __init__(
        self,
        req: ActionRequest,
        *,
        active_checks: int = 0,
        mode: OperatingMode = "local",
        force_required: bool = False,
    ) -> None:
        super().__init__()
        self.req = req
        self.active_checks = max(0, int(active_checks))
        self.mode = mode
        self.force_required = force_required or (
            self.active_checks > 0 and (req.service == "etymos-api" or req.action in ("restart-api", "shutdown-api"))
        )

    def compose(self):
        target = self.req.service or self.req.action
        with Vertical(id="modal-dialog", classes="modal-box confirm-box"):
            yield Static(f"Confirm: {self.req.action} ({target})", classes="modal-title")
            lines = Text()
            if self.force_required:
                lines.append(
                    f"WARNING: {self.active_checks} verification check(s) are actively running and will be interrupted/lost!\n",
                    style="bold red",
                )
            else:
                lines.append(f"Proceed with `{self.req.action}` on `{target}`?\n")
            if self.mode == "remote" and self.req.service == "cloudflared":
                lines.append(
                    "\nREMOTE SESSION WARNING: Restarting or stopping cloudflared will immediately disconnect this remote TUI session!",
                    style="bold yellow",
                )
            yield Static(lines, id="confirm-body")
            with Horizontal(classes="modal-buttons"):
                if self.force_required:
                    yield Button(
                        f"Force Interrupt {self.active_checks} Check(s)",
                        variant="error",
                        id="btn-force-confirm",
                    )
                else:
                    yield Button("Confirm", variant="warning", id="btn-confirm")
                yield Button("Cancel", variant="primary", id="btn-cancel-confirm")

    def on_mount(self) -> None:
        self.query_one("#btn-cancel-confirm", Button).focus()

    def action_cancel(self) -> None:
        self.dismiss((False, False))

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "btn-force-confirm":
            self.dismiss((True, True))
        elif event.button.id == "btn-confirm":
            self.dismiss((True, False))
        else:
            self.dismiss((False, False))


class ConfirmCommandModal(ModalScreen[bool]):
    """Destructive command confirmation dialog returning `True` only when explicitly confirmed."""

    BINDINGS = [
        Binding("escape", "cancel", "Cancel"),
        Binding("n", "cancel", "Cancel"),
    ]

    def __init__(
        self,
        command: str,
        match: DestructiveMatch,
        *,
        mode: OperatingMode = "local",
    ) -> None:
        super().__init__()
        self.command = sanitize_log_text(command, preserve_newlines=False)
        self.match = match
        self.mode = mode

    def compose(self):
        with Vertical(id="modal-dialog", classes="modal-box confirm-box"):
            yield Static(
                f"Confirm Potentially Destructive Command [{self.match.pattern_name}]",
                classes="modal-title",
            )
            body = Text()
            tone = "bold red" if self.match.severity == "critical" else "bold yellow"
            body.append(f"{self.match.severity.upper()}: {self.match.reason}\n\n", style=tone)
            body.append("Command:\n", style="dim")
            body.append(f"  {self.command}\n", style="bold")
            yield Static(body, id="confirm-cmd-body")
            with Horizontal(classes="modal-buttons"):
                yield Button(
                    "Execute Anyway",
                    variant="error" if self.match.severity == "critical" else "warning",
                    id="btn-confirm-cmd",
                )
                yield Button("Cancel [Esc]", variant="primary", id="btn-cancel-cmd")

    def on_mount(self) -> None:
        self.query_one("#btn-cancel-cmd", Button).focus()

    def action_cancel(self) -> None:
        self.dismiss(False)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        self.dismiss(event.button.id == "btn-confirm-cmd")


class HelpModal(ModalScreen[None]):
    """Keyboard shortcuts & log source legend overlay."""

    BINDINGS = [
        Binding("escape", "close", "Close"),
        Binding("question_mark", "close", "Close"),
        Binding("q", "close", "Close"),
        Binding("enter", "close", "Close"),
    ]

    def __init__(self, *, mode: OperatingMode, target_label: str) -> None:
        super().__init__()
        self.mode = mode
        self.target_label = target_label

    def compose(self):
        with Vertical(id="modal-dialog", classes="modal-box help-box"):
            yield Static(
                f"Etymos Server TUI Help  —  Mode: {self.mode.upper()} ({self.target_label})",
                classes="modal-title",
            )
            help_text = Text()
            shortcuts = [
                ("Tab / Shift+Tab", "Cycle focus across Stats -> Checks -> Logs (-> Command when open)"),
                ("z / Esc", "Toggle full-screen zoom on focused pane / Close overlay / Blur prompt"),
                (": / x", "Toggle bottom Command Pane ($SV and server diagnostics) & focus prompt"),
                ("↑ / ↓ (in Cmd)", "Recall previous session commands (preserving current draft)"),
                ("Ctrl+X / Ctrl+C", "Cancel actively running command (Ctrl+C exits cleanly when idle)"),
                ("Ctrl+L (in Cmd)", "Clear command transcript output"),
                ("1..8 or [ / ]", "Switch log source (1=Live, 2=api, 3=api-out, 4=deploy, 5=tests, 6=tunnel, 7=supervisor, 8=autostart)"),
                ("/", "Focus search filter (supports plain text + job:<id> req:<id> user:<id>)"),
                ("l", "Cycle minimum log severity (DEBUG -> INFO -> WARNING -> ERROR)"),
                ("c", "Clear all active log filters"),
                ("p / Space", "Pause or resume live log auto-follow"),
                ("Up/Down, j/k, PgUp/PgDn", "Scroll or select row (scrolling up pauses auto-follow)"),
                ("g / G", "Jump to oldest buffered line / Jump to live tail & resume"),
                ("Enter / e (in Logs)", "Expand or collapse inline error traceback"),
                ("f (in Logs)", "Quick-filter logs by highlighted row's job/request/user tag"),
                ("Enter (in Checks)", "Filter live logs by the selected verification check"),
                ("a / Ctrl+P", "Open allowlisted Operational Actions Menu"),
                ("r", "Force immediate telemetry refresh / reconnect"),
                ("? / F1", "Toggle this help screen"),
                ("q", "Exit cleanly and restore terminal state"),
            ]
            for key, desc in shortcuts:
                help_text.append(f"  {key:<24}", style="bold cyan")
                help_text.append(f"{desc}\n")
            yield Static(help_text, id="help-body")
            with Horizontal(classes="modal-buttons"):
                yield Button("Close [Esc]", variant="primary", id="btn-close-help")

    def on_mount(self) -> None:
        self.query_one("#btn-close-help", Button).focus()

    def action_close(self) -> None:
        self.dismiss(None)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        self.dismiss(None)
