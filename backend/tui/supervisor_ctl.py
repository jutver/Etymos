"""Allowlisted `supervisorctl` status parser and service lifecycle runner."""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path
from typing import Literal, Optional

from .models import MANAGED_SERVICES, ManagedServiceInfo, ManagedServiceName
from .sanitize import sanitize_log_text

_STATUS_LINE_RE = re.compile(r"^([A-Za-z0-9_.:-]+)\s+([A-Z]+)(?:\s+(.*))?$")
_PID_RE = re.compile(r"\bpid\s+(\d+)\b")
_UPTIME_RE = re.compile(r"\buptime\s+([0-9:,\s\w-]+?)$")


def default_backend_dir() -> Path:
    return Path(__file__).resolve().parent.parent


def resolve_supervisor_paths(
    backend_dir: Optional[Path] = None,
    supervisorctl: Optional[Path] = None,
    conf: Optional[Path] = None,
) -> tuple[Path, Path]:
    base = backend_dir or default_backend_dir()
    if supervisorctl is None:
        venv_bin = base / ".venv" / "bin" / "supervisorctl"
        if venv_bin.exists():
            supervisorctl = venv_bin
        else:
            found = shutil.which("supervisorctl")
            supervisorctl = Path(found) if found else venv_bin
    if conf is None:
        conf = base / "supervisord.conf"
    return supervisorctl, conf


def parse_supervisor_status(output: str) -> list[ManagedServiceInfo]:
    """Parse `supervisorctl status` stdout lines into ManagedServiceInfo rows."""
    services: list[ManagedServiceInfo] = []
    for raw_line in (output or "").splitlines():
        line = sanitize_log_text(raw_line, preserve_newlines=False).strip()
        if not line:
            continue
        match = _STATUS_LINE_RE.match(line)
        if not match:
            continue
        name, state, detail = match.group(1), match.group(2), (match.group(3) or "").strip()
        pid_match = _PID_RE.search(detail)
        uptime_match = _UPTIME_RE.search(detail)
        services.append(
            ManagedServiceInfo(
                name=name,
                state=state,
                pid=int(pid_match.group(1)) if pid_match else None,
                uptime=uptime_match.group(1).strip() if uptime_match else None,
                detail=detail,
            )
        )
    return services


class LocalSupervisorController:
    """Strictly allowlisted wrapper around `supervisorctl` (never uses shell=True)."""

    def __init__(
        self,
        *,
        backend_dir: Optional[Path] = None,
        supervisorctl: Optional[Path] = None,
        conf: Optional[Path] = None,
    ) -> None:
        self.supervisorctl, self.conf = resolve_supervisor_paths(
            backend_dir=backend_dir,
            supervisorctl=supervisorctl,
            conf=conf,
        )

    def is_available(self) -> bool:
        return self.supervisorctl.exists() and self.conf.exists()

    def list_services(self, timeout: float = 2.0) -> list[ManagedServiceInfo]:
        if not self.is_available():
            return []
        try:
            proc = subprocess.run(
                [str(self.supervisorctl), "-c", str(self.conf), "status"],
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            combined = proc.stdout or proc.stderr or ""
            return parse_supervisor_status(combined)
        except Exception:
            return []

    def control_service(
        self,
        verb: Literal["start", "restart", "stop"],
        service: ManagedServiceName,
        timeout: float = 15.0,
    ) -> tuple[bool, str]:
        if verb not in ("start", "restart", "stop"):
            raise ValueError(f"Unsupported supervisor verb: {verb!r}")
        if service not in MANAGED_SERVICES:
            raise ValueError(f"Service {service!r} is not in MANAGED_SERVICES.")
        if not self.is_available():
            return False, "Supervisor is not configured on this host."
        try:
            proc = subprocess.run(
                [str(self.supervisorctl), "-c", str(self.conf), verb, service],
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            out = sanitize_log_text(proc.stdout or proc.stderr or "", preserve_newlines=False).strip()
            return proc.returncode == 0, out or f"{service}: {verb} exit {proc.returncode}"
        except subprocess.TimeoutExpired:
            return False, f"Timed out waiting for supervisorctl {verb} {service}."
        except OSError as exc:
            return False, sanitize_log_text(str(exc), preserve_newlines=False)
