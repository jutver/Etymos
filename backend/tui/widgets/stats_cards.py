"""Reactive telemetry stat cards, threshold meters, and managed services strip."""
from __future__ import annotations

from typing import Optional

from rich.text import Text
from textual.containers import Container
from textual.widgets import Static

from ..models import ManagedServiceInfo, ServerSnapshot
from ..sanitize import (
    clamp_percent,
    format_gb,
    format_iso_local,
    format_mb,
    sanitize_log_text,
    threshold_level,
    truncate_middle,
)


def render_bar(used: Optional[float], total: Optional[float], width: int = 16, *, no_color: bool = False) -> Text:
    """Render a compact horizontal utilization meter with warning/critical thresholds."""
    text = Text()
    if used is None or total is None or total <= 0:
        text.append("[" + "─" * width + "] —", style="" if no_color else "dim")
        return text
    pct = clamp_percent(used, total)
    filled = max(0, min(width, round((pct / 100.0) * width)))
    level = threshold_level(pct)
    if no_color:
        bar = "#" * filled + "-" * (width - filled)
        suffix = f" {pct:4.0f}%" + (" [WARN]" if level == "warning" else " [CRIT]" if level == "critical" else "")
        text.append(f"[{bar}]{suffix}")
        return text

    color = "red" if level == "critical" else "yellow" if level == "warning" else "bright_blue"
    text.append("█" * filled, style=color)
    text.append("░" * (width - filled), style="dim")
    text.append(f" {pct:4.0f}%", style=f"bold {color}" if level != "normal" else "dim")
    return text


def _kv(line_label: str, value: str, *, style: str = "", no_color: bool = False) -> Text:
    row = Text()
    row.append(f"{line_label:<16}", style="" if no_color else "dim")
    row.append(sanitize_log_text(value, preserve_newlines=False), style="" if no_color else style)
    return row


class _BaseCard(Static):
    CARD_TITLE = ""

    def __init__(self, *, no_color: bool = False, **kwargs) -> None:
        super().__init__(**kwargs)
        self._no_color = no_color
        self._snapshot: Optional[ServerSnapshot] = None

    def set_snapshot(self, snapshot: ServerSnapshot) -> None:
        self._snapshot = snapshot
        self.refresh()


class ApiProcessCard(_BaseCard):
    CARD_TITLE = "API process"

    def render(self) -> Text:
        snap = self._snapshot
        out = Text()
        out.append(f"{self.CARD_TITLE}\n", style="bold" if self._no_color else "bold cyan")
        if snap is None or not snap.api.online:
            sup = "Supervisor" if (snap and snap.api.supervised) else "Manual"
            rows = [
                _kv("Status", "OFFLINE / WARMING UP", style="bold red", no_color=self._no_color),
                _kv("Up for", "—", no_color=self._no_color),
                _kv("Started", "—", no_color=self._no_color),
                _kv("Process", "—", no_color=self._no_color),
                _kv("Auto-restart", sup, no_color=self._no_color),
            ]
        else:
            api = snap.api
            pid_threads = f"{api.pid} · {api.threads} threads" if api.pid and api.threads is not None else str(api.pid or "—")
            rows = [
                _kv("Up for", api.uptime or "—", style="bold green", no_color=self._no_color),
                _kv("Started", format_iso_local(api.started_at), no_color=self._no_color),
                _kv("Version", truncate_middle(api.commit or "?", 30), no_color=self._no_color),
                _kv("Process", pid_threads, no_color=self._no_color),
                _kv("Log level", api.log_level or "INFO", no_color=self._no_color),
                _kv("Python", api.python or "—", no_color=self._no_color),
            ]
        for idx, r in enumerate(rows):
            if idx > 0:
                out.append("\n")
            out.append_text(r)
        return out


class MachineCard(_BaseCard):
    CARD_TITLE = "Machine"

    def render(self) -> Text:
        snap = self._snapshot
        out = Text()
        out.append(f"{self.CARD_TITLE}\n", style="bold" if self._no_color else "bold cyan")
        if snap is None:
            out.append("Waiting for host telemetry…")
            return out
        m = snap.machine
        load_str = (
            f"{m.load[0]:.2f} / {m.load[1]:.2f} / {m.load[2]:.2f}"
            + (f" · {m.cpus} CPUs" if m.cpus else "")
            if m.load
            else (f"— · {m.cpus} CPUs" if m.cpus else "—")
        )
        mem_used = (
            max(0.0, m.system_total_mb - m.system_available_mb)
            if (m.system_total_mb is not None and m.system_available_mb is not None)
            else None
        )
        mem_str = (
            f"{format_mb(m.system_available_mb)} / {format_mb(m.system_total_mb)}"
            if m.system_total_mb is not None
            else "—"
        )
        api_mem_str = (
            f"{format_mb(m.api_rss_mb)} · peak {format_mb(m.api_peak_mb)}"
            if m.api_rss_mb is not None
            else "—"
        )
        disk_used = (
            max(0.0, m.disk.total_gb - m.disk.free_gb)
            if m.disk is not None
            else None
        )
        disk_str = (
            f"{format_gb(m.disk.free_gb, 1)} / {format_gb(m.disk.total_gb, 1)}"
            if m.disk is not None
            else "—"
        )
        out.append_text(_kv("Host", truncate_middle(m.host, 28), no_color=self._no_color))
        out.append("\n")
        out.append_text(_kv("Load (1/5/15m)", load_str, no_color=self._no_color))
        out.append("\n")
        out.append_text(_kv("Memory free", mem_str, no_color=self._no_color))
        out.append("\n")
        out.append_text(render_bar(mem_used, m.system_total_mb, width=18, no_color=self._no_color))
        out.append("\n")
        out.append_text(_kv("API memory", api_mem_str, no_color=self._no_color))
        out.append("\n")
        out.append_text(_kv("Disk free", disk_str, no_color=self._no_color))
        out.append("\n")
        out.append_text(render_bar(disk_used, m.disk.total_gb if m.disk else None, width=18, no_color=self._no_color))
        return out


class GpuCard(_BaseCard):
    CARD_TITLE = "GPU"

    def render(self) -> Text:
        snap = self._snapshot
        out = Text()
        out.append(f"{self.CARD_TITLE}\n", style="bold" if self._no_color else "bold cyan")
        if snap is None:
            out.append("Waiting for GPU telemetry…")
            return out
        g = snap.gpu
        if not g.available:
            out.append_text(_kv("Card", "Not available (CPU mode)", style="dim", no_color=self._no_color))
            if g.queue:
                out.append("\n")
                out.append_text(_kv("Check slots", f"{g.queue.running}/{g.queue.slots} busy · {g.queue.waiting} waiting", no_color=self._no_color))
            if g.error:
                out.append("\n")
                out.append_text(_kv("Note", truncate_middle(g.error, 26), style="yellow", no_color=self._no_color))
            return out

        vram_used = (
            max(0.0, g.total_gb - g.free_gb)
            if (g.total_gb is not None and g.free_gb is not None)
            else g.allocated_gb
        )
        vram_str = (
            f"{format_gb(g.free_gb)} / {format_gb(g.total_gb)}"
            if (g.free_gb is not None and g.total_gb is not None)
            else "—"
        )
        models_mem = (
            f"{format_gb(g.allocated_gb, 2)} · peak {format_gb(g.peak_gb, 2)}"
            if g.allocated_gb is not None
            else ("— (API offline)" if not snap.api.online else "0 GB · peak 0 GB")
        )
        slots_str = (
            f"{g.queue.running}/{g.queue.slots} busy · {g.queue.waiting} waiting"
            if g.queue
            else ("—" if not snap.api.online else "0/0 busy")
        )
        loaded_str = ", ".join(f"{m.name}({m.size_gb:.1f}G)" for m in g.models) if g.models else "none"

        out.append_text(_kv("Card", truncate_middle(g.name or "GPU", 28), no_color=self._no_color))
        out.append("\n")
        out.append_text(_kv("Memory free", vram_str, no_color=self._no_color))
        out.append("\n")
        out.append_text(render_bar(vram_used, g.total_gb, width=18, no_color=self._no_color))
        out.append("\n")
        out.append_text(_kv("Used by models", models_mem, no_color=self._no_color))
        out.append("\n")
        out.append_text(_kv("Check slots", slots_str, no_color=self._no_color))
        out.append("\n")
        out.append_text(_kv("Models loaded", truncate_middle(loaded_str, 26), no_color=self._no_color))
        return out


class BackgroundWorkCard(_BaseCard):
    CARD_TITLE = "Background work"

    def render(self) -> Text:
        snap = self._snapshot
        out = Text()
        out.append(f"{self.CARD_TITLE}\n", style="bold" if self._no_color else "bold cyan")
        if snap is None:
            out.append("Waiting for worker state…")
            return out
        bg = snap.background

        def _worker_txt(flag: Optional[bool]) -> tuple[str, str]:
            if flag is None:
                return "Unknown (API off)", "yellow"
            return ("Running", "green") if flag else ("Stopped", "red")

        notif_txt, notif_style = _worker_txt(bg.notifications)
        inbox_txt, inbox_style = _worker_txt(bg.support_inbox)
        fail_style = "bold red" if bg.failed_since_start > 0 else ""

        rows = [
            _kv("Notifications", notif_txt, style=notif_style, no_color=self._no_color),
            _kv("Support inbox", inbox_txt, style=inbox_style, no_color=self._no_color),
            _kv("Checks started", str(bg.checks_since_start), no_color=self._no_color),
            _kv("Failed checks", str(bg.failed_since_start), style=fail_style, no_color=self._no_color),
            _kv("Auto-restart", bg.auto_restart, no_color=self._no_color),
        ]
        for idx, r in enumerate(rows):
            if idx > 0:
                out.append("\n")
            out.append_text(r)
        return out


class ServicesStrip(Static):
    """Single-line summary strip of supervisor-managed processes."""

    def __init__(self, *, no_color: bool = False, **kwargs) -> None:
        super().__init__(**kwargs)
        self._no_color = no_color
        self._services: list[ManagedServiceInfo] = []

    def set_services(self, services: list[ManagedServiceInfo]) -> None:
        self._services = services
        self.refresh()

    def render(self) -> Text:
        text = Text()
        text.append("Services: ", style="bold" if self._no_color else "bold cyan")
        if not self._services:
            text.append("No managed supervisor services reported", style="" if self._no_color else "dim")
            return text
        for idx, svc in enumerate(self._services):
            if idx > 0:
                text.append("   ")
            if self._no_color:
                style = "bold"
            elif svc.state == "RUNNING":
                style = "bold green"
            elif svc.state in ("STARTING", "BACKOFF"):
                style = "bold yellow"
            else:
                style = "bold red"
            text.append(f"{svc.name}:", style="" if self._no_color else "white")
            text.append(svc.state, style=style)
            if svc.pid:
                text.append(f"({svc.pid})", style="" if self._no_color else "dim")
        return text


class StatsGrid(Container):
    """Container holding the four telemetry cards + Managed Services strip."""

    def __init__(self, *, no_color: bool = False, **kwargs) -> None:
        super().__init__(**kwargs)
        self.api_card = ApiProcessCard(no_color=no_color, id="card-api", classes="stat-card")
        self.machine_card = MachineCard(no_color=no_color, id="card-machine", classes="stat-card")
        self.gpu_card = GpuCard(no_color=no_color, id="card-gpu", classes="stat-card")
        self.bg_card = BackgroundWorkCard(no_color=no_color, id="card-bg", classes="stat-card")
        self.services_strip = ServicesStrip(no_color=no_color, id="services-strip")

    def compose(self):
        with Container(id="cards-row"):
            yield self.api_card
            yield self.machine_card
            yield self.gpu_card
            yield self.bg_card
        yield self.services_strip

    def update_snapshot(self, snapshot: ServerSnapshot) -> None:
        self.api_card.set_snapshot(snapshot)
        self.machine_card.set_snapshot(snapshot)
        self.gpu_card.set_snapshot(snapshot)
        self.bg_card.set_snapshot(snapshot)
        self.services_strip.set_services(snapshot.services)
