"""Sanitization, markup-safe Rich formatting, and display helpers for the Etymos TUI."""
from __future__ import annotations

import math
import re
from datetime import datetime
from typing import Any, Literal

from rich.text import Text

# ANSI escape sequences: CSI, OSC (BEL or ST terminated), and 2-byte ESC sequences.
_OSC_RE = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?")
_CSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_ESC_RE = re.compile(r"\x1b[@-Z\\-_]")
# C0 controls except \t (handled separately) and \n; plus DEL and C1 (0x7f-0x9f).
_CTRL_PRESERVE_NL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
_CTRL_SINGLE_LINE_RE = re.compile(r"[\x00-\x08\x0a-\x1f\x7f-\x9f]")


def sanitize_log_text(value: Any, *, preserve_newlines: bool = True) -> str:
    """Strip ANSI escape/control sequences and safely decode untrusted log strings.

    Never raises on non-string values or malformed byte sequences.
    """
    if value is None:
        return ""
    if isinstance(value, (bytes, bytearray)):
        text = bytes(value).decode("utf-8", errors="replace")
    else:
        text = str(value)
    text = text.replace("\r\n", "\n").replace("\r", "\n" if preserve_newlines else " ")
    text = _OSC_RE.sub("", text)
    text = _CSI_RE.sub("", text)
    text = _ESC_RE.sub("", text)
    text = text.replace("\x1b", "")
    text = text.replace("\t", "    ")
    pattern = _CTRL_PRESERVE_NL_RE if preserve_newlines else _CTRL_SINGLE_LINE_RE
    return pattern.sub("", text)


def safe_text(value: Any, style: str = "", *, no_wrap: bool = False) -> Text:
    """Return a plain Rich Text object with markup interpretation disabled."""
    return Text(sanitize_log_text(value, preserve_newlines=True), style=style, no_wrap=no_wrap)


def threshold_level(percent: float) -> Literal["normal", "warning", "critical"]:
    """Classify utilization percentage using the admin portal's 75% / 90% thresholds."""
    if not math.isfinite(percent):
        return "normal"
    if percent > 90.0:
        return "critical"
    if percent > 75.0:
        return "warning"
    return "normal"


def clamp_percent(used: float | None, total: float | None) -> float:
    """Compute bounded percentage in [0.0, 100.0]."""
    if used is None or total is None or total <= 0:
        return 0.0
    pct = (used / total) * 100.0
    if not math.isfinite(pct):
        return 0.0
    return max(0.0, min(100.0, pct))


def format_gb(value: float | None, decimals: int = 2) -> str:
    if value is None or not math.isfinite(value):
        return "—"
    return f"{value:.{decimals}f} GB"


def format_mb(value: float | None) -> str:
    if value is None or not math.isfinite(value):
        return "—"
    if value >= 1024:
        return f"{value / 1024:.1f} GB"
    return f"{round(value)} MB"


def format_bytes(size: int | None) -> str:
    if size is None or size < 0:
        return "0 B"
    units = ("B", "KB", "MB", "GB")
    num = float(size)
    for unit in units:
        if num < 1024.0 or unit == units[-1]:
            return f"{num:.0f} {unit}" if unit == "B" else f"{num:.1f} {unit}"
        num /= 1024.0
    return f"{size} B"


def format_seconds(seconds: float | None) -> str:
    if seconds is None or not math.isfinite(seconds):
        return "—"
    total = max(0, round(seconds))
    if total < 60:
        return f"{total}s"
    mins, secs = divmod(total, 60)
    if mins < 60:
        return f"{mins}m {secs:02d}s"
    hours, mins = divmod(mins, 60)
    if hours < 24:
        return f"{hours}h {mins:02d}m"
    days, hours = divmod(hours, 24)
    return f"{days}d {hours}h"


def format_log_time(ts: float | None) -> str:
    if ts is None or not math.isfinite(ts):
        return "--:--:--"
    try:
        dt = datetime.fromtimestamp(ts)
        return dt.strftime("%H:%M:%S") + f".{int(dt.microsecond / 1000):03d}"
    except (OSError, OverflowError, ValueError):
        return "--:--:--"


def format_iso_local(iso_str: str | None) -> str:
    if not iso_str:
        return "—"
    raw = sanitize_log_text(iso_str, preserve_newlines=False).strip()
    if not raw:
        return "—"
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is not None:
            dt = dt.astimezone()
        return dt.strftime("%Y-%m-%d %H:%M:%S")
    except ValueError:
        return raw[:24]


def mask_email(email: str | None) -> str:
    """Mask an email address for UI header display (never reveal full personal emails)."""
    clean = sanitize_log_text(email, preserve_newlines=False).strip()
    if not clean or "@" not in clean:
        return clean
    local, domain = clean.split("@", 1)
    if not local:
        return f"***@{domain}"
    return f"{local[0]}***@{domain}"


def short_job(job_id: str | None) -> str:
    clean = sanitize_log_text(job_id, preserve_newlines=False).strip()
    if not clean:
        return "-"
    return clean[:12] if clean.startswith("job_") else clean[:8]


def truncate_middle(text: str, max_len: int) -> str:
    clean = sanitize_log_text(text, preserve_newlines=False)
    if max_len <= 0:
        return ""
    if len(clean) <= max_len:
        return clean
    if max_len <= 3:
        return clean[:max_len]
    return clean[: max_len - 1] + "…"
