"""Header bar displaying mode pill, connection state, staleness, KPIs, and PID restart notice."""
from __future__ import annotations

import time
from typing import Optional

from rich.text import Text
from textual.reactive import reactive
from textual.widgets import Static

from ..models import ConnectionState, OperatingMode, ServerSnapshot
from ..sanitize import clamp_percent, format_gb, sanitize_log_text


class HeaderBar(Static):
    """Compact 1-2 line status header pinned to the top of the workspace."""

    mode: reactive[OperatingMode] = reactive("local")
    connection_state: reactive[ConnectionState] = reactive("connecting")
    stale: reactive[bool] = reactive(False)
    target_label: reactive[str] = reactive("")
    restart_notice: reactive[str] = reactive("")

    def __init__(
        self,
        *,
        mode: OperatingMode = "local",
        target_label: str = "",
        no_color: bool = False,
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self._no_color = no_color
        self._snapshot: Optional[ServerSnapshot] = None
        self.mode = mode
        self.target_label = sanitize_log_text(target_label, preserve_newlines=False)

    def update_state(
        self,
        *,
        snapshot: Optional[ServerSnapshot] = None,
        connection_state: Optional[ConnectionState] = None,
        stale: Optional[bool] = None,
        restart_notice: Optional[str] = None,
    ) -> None:
        if snapshot is not None:
            self._snapshot = snapshot
        if connection_state is not None:
            self.connection_state = connection_state
        if stale is not None:
            self.stale = stale
        if restart_notice is not None:
            self.restart_notice = sanitize_log_text(restart_notice, preserve_newlines=False)
        self.refresh()

    def render(self) -> Text:
        text = Text()
        mode_tag = "LOCAL SERVER" if self.mode == "local" else f"REMOTE {self.target_label or 'API'}"
        text.append(f" ETYMOS TUI ", style="bold reverse" if self._no_color else "bold white on #1d4ed8")
        text.append(f" [{mode_tag}] ", style="bold" if self._no_color else "bold cyan")

        state_map = {
            "connected": ("● LIVE", "bold" if self._no_color else "bold green"),
            "api_offline_host_live": ("● API OFFLINE · HOST LIVE", "bold" if self._no_color else "bold yellow"),
            "reconnecting": ("◐ RECONNECTING…", "bold" if self._no_color else "bold yellow"),
            "connecting": ("◐ CONNECTING…", "bold" if self._no_color else "bold cyan"),
            "auth_required": ("✕ AUTH REQUIRED", "bold" if self._no_color else "bold red"),
            "disconnected": ("✕ DISCONNECTED", "bold" if self._no_color else "bold red"),
        }
        badge, badge_style = state_map.get(self.connection_state, ("?", "bold"))
        text.append(badge, style=badge_style)

        if self.stale:
            text.append(" [STALE]", style="bold" if self._no_color else "bold red")

        snap = self._snapshot
        if snap is not None:
            load_str = f"{snap.machine.load[0]:.2f}" if snap.machine.load else "—"
            ram_str = "—"
            if snap.machine.system_total_mb and snap.machine.system_available_mb is not None:
                used = snap.machine.system_total_mb - snap.machine.system_available_mb
                ram_pct = clamp_percent(used, snap.machine.system_total_mb)
                ram_str = f"{ram_pct:.0f}%"
            vram_str = "n/a"
            if snap.gpu.available and snap.gpu.total_gb:
                vram_used = (
                    (snap.gpu.total_gb - snap.gpu.free_gb)
                    if snap.gpu.free_gb is not None
                    else snap.gpu.allocated_gb
                )
                vram_str = f"{format_gb(vram_used, 1)}/{format_gb(snap.gpu.total_gb, 1)}"
            active_n = len(snap.active_checks)
            up = snap.api.uptime if snap.api.online and snap.api.uptime else "down"
            age_s = max(0.0, time.monotonic() - snap.received_at_mono) if snap.received_at_mono else 0.0
            text.append(
                f"  |  Up:{up}  Load:{load_str}  RAM:{ram_str}  VRAM:{vram_str}  Checks:{active_n}  ({age_s:.0f}s ago)",
                style="" if self._no_color else "dim white",
            )

        if self.restart_notice:
            text.append(f"  ★ {self.restart_notice}", style="bold" if self._no_color else "bold magenta")

        text.append("   [:]Cmd [?]Help [a]Actions [z]Zoom [q]Quit", style="" if self._no_color else "dim cyan")
        return text
