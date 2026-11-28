"""Client-side destructive command guardrails for ConfirmCommandModal."""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal, Optional

from .models import OperatingMode


@dataclass
class DestructiveMatch:
    pattern_name: str
    reason: str
    severity: Literal["warning", "critical"]


_RM_CMD_RE = re.compile(r"(?:^|[;&|()]\s*|\bsudo\s+)rm\b([^\n;&|]*)", re.IGNORECASE)
_RM_TARGET_DANGER_RE = re.compile(
    r"(?:^|\s)(?:/\*{0,2}|~(?:/\S*)?|\$HOME(?:/\S*)?|\.\.?(?:/\S*)?|/(?:workspace|etc|usr|var|bin|lib|opt|root|home)(?:/\S*)?)(?:\s|$)"
)
_GIT_DESTRUCTIVE_RE = re.compile(
    r"(?:^|[;&|()]\s*|\bsudo\s+)git\s+(?:reset\s+--hard\b|clean\s+[^\n;&|]*(?:-[^\s]*f|--force))",
    re.IGNORECASE,
)
_HOST_POWER_RE = re.compile(
    r"(?:^|[;&|()]\s*|\bsudo\s+)(?:shutdown|reboot|poweroff|halt|init\s+[06])\b",
    re.IGNORECASE,
)
_DISK_WIPE_RE = re.compile(
    r"(?:^|[;&|()]\s*|\bsudo\s+)(?:(?:mkfs(?:\.[a-z0-9]+)?|wipefs|fdisk)\b|dd\s+if=)",
    re.IGNORECASE,
)
_SQL_DESTRUCTIVE_RE = re.compile(
    r"\b(?:DROP\s+TABLE|DROP\s+DATABASE|TRUNCATE)\b",
    re.IGNORECASE,
)
_REMOTE_TUNNEL_RE = re.compile(
    r"(?:\$SV|\bsupervisorctl\b[^\n;&|]*)\s+(?:stop|restart)\s+(?:all\b|[^\n;&|]*\bcloudflared\b)"
    r"|(?:^|[;&|()]\s*|\bsudo\s+)(?:pkill|killall)\s+[^\n;&|]*\bcloudflared\b",
    re.IGNORECASE,
)


def _has_recursive_and_force_flags(rm_args: str) -> bool:
    tokens = rm_args.split()
    has_r = False
    has_f = False
    for tok in tokens:
        if tok == "--":
            break
        if tok == "--recursive":
            has_r = True
        elif tok == "--force":
            has_f = True
        elif tok.startswith("-") and not tok.startswith("--"):
            flags = tok[1:].lower()
            if "r" in flags:
                has_r = True
            if "f" in flags:
                has_f = True
    return has_r and has_f


def detect_destructive_command(command: str, *, mode: OperatingMode = "local") -> Optional[DestructiveMatch]:
    """Inspect command text before dispatch and return warning metadata if high-risk."""
    text = (command or "").strip()
    if not text:
        return None

    for match in _RM_CMD_RE.finditer(text):
        args = match.group(1) or ""
        if _has_recursive_and_force_flags(args) and _RM_TARGET_DANGER_RE.search(args):
            return DestructiveMatch(
                pattern_name="rm_rf",
                reason="Recursive forced file deletion (`rm -rf`) targeting a critical or broad path.",
                severity="critical",
            )

    if _GIT_DESTRUCTIVE_RE.search(text):
        return DestructiveMatch(
            pattern_name="git_destructive",
            reason="Destructive Git reset/clean discards uncommitted changes or untracked local server files (like backend/.env).",
            severity="critical",
        )

    if _HOST_POWER_RE.search(text):
        return DestructiveMatch(
            pattern_name="host_power",
            reason="Host shutdown/reboot command will terminate the server and all active sessions.",
            severity="critical",
        )

    if _DISK_WIPE_RE.search(text):
        return DestructiveMatch(
            pattern_name="disk_wipe",
            reason="Low-level disk/filesystem command (`mkfs`/`dd`/`wipefs`/`fdisk`) risks irreversible data loss.",
            severity="critical",
        )

    if _SQL_DESTRUCTIVE_RE.search(text):
        return DestructiveMatch(
            pattern_name="sql_destructive",
            reason="Destructive SQL statement (`DROP`/`TRUNCATE`) detected.",
            severity="critical",
        )

    if mode == "remote" and _REMOTE_TUNNEL_RE.search(text):
        return DestructiveMatch(
            pattern_name="remote_tunnel_stop",
            reason="Stopping or restarting `cloudflared` from Remote Mode will immediately drop the Cloudflare tunnel and disconnect your TUI session.",
            severity="warning",
        )

    return None
