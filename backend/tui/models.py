"""Typed domain models, merge logic, and bounded log storage for the Etymos TUI."""
from __future__ import annotations

import logging
import math
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Literal, Optional

from .sanitize import sanitize_log_text

OperatingMode = Literal["local", "remote"]
ConnectionState = Literal[
    "connecting",
    "connected",
    "reconnecting",
    "api_offline_host_live",
    "auth_required",
    "disconnected",
]
LogSourceId = Literal[
    "live",
    "api",
    "api-out",
    "deploy",
    "tests",
    "tunnel",
    "supervisor",
    "autostart",
]
LogLevel = Literal["DEBUG", "INFO", "WARNING", "ERROR"]
PaneId = Literal["stats", "checks", "logs"]
ViewportBreakpoint = Literal["too_small", "narrow", "medium", "wide"]
ManagedServiceName = Literal["etymos-api", "cloudflared", "etymos-deploy"]

LOG_LEVELS: tuple[LogLevel, ...] = ("DEBUG", "INFO", "WARNING", "ERROR")
LOG_LEVEL_VALUES: dict[str, int] = {
    "DEBUG": logging.DEBUG,
    "INFO": logging.INFO,
    "WARNING": logging.WARNING,
    "ERROR": logging.ERROR,
    "CRITICAL": logging.CRITICAL,
    "RAW": logging.INFO,
}

LOG_SOURCE_ORDER: tuple[LogSourceId, ...] = (
    "live",
    "api",
    "api-out",
    "deploy",
    "tests",
    "tunnel",
    "supervisor",
    "autostart",
)

LOG_SOURCE_LABELS: dict[LogSourceId, str] = {
    "live": "Live",
    "api": "api",
    "api-out": "api-out",
    "deploy": "deploy",
    "tests": "tests",
    "tunnel": "tunnel",
    "supervisor": "supervisor",
    "autostart": "autostart",
}

LOG_FILE_NAMES: dict[str, tuple[str, str]] = {
    "api": ("api.err.log", "API: everything logged, across restarts"),
    "api-out": ("api.out.log", "API: anything written straight to stdout"),
    "deploy": ("deploy.log", "Auto-deploy: pulls, test runs, restarts, rollbacks"),
    "tests": ("deploy_tests.log", "Last backend test run before a deploy"),
    "tunnel": ("cloudflared.err.log", "Cloudflare tunnel"),
    "supervisor": ("supervisord.log", "Supervisor: process starts, exits and crashes"),
    "autostart": ("autostart.log", "Auto-start: host boot recovery and supervisor launches"),
}

MANAGED_SERVICES: tuple[ManagedServiceName, ...] = (
    "etymos-api",
    "cloudflared",
    "etymos-deploy",
)

ALLOWED_ACTIONS: tuple[str, ...] = (
    "log-level",
    "dump-threads",
    "free-gpu",
    "run-notifications",
    "poll-support-inbox",
    "restart-api",
    "shutdown-api",
    "restart-service",
    "stop-service",
    "start-service",
)


def _as_int(value: Any, default: Optional[int] = None) -> Optional[int]:
    if value is None or isinstance(value, bool):
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_float(value: Any, default: Optional[float] = None) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return default
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) else default
    except (TypeError, ValueError):
        return default


def compute_breakpoint(width: int, height: int) -> ViewportBreakpoint:
    """Classify terminal dimensions per data-model.md §4.3."""
    if width < 56 or height < 14:
        return "too_small"
    if width < 100:
        return "narrow"
    if width < 148:
        return "medium"
    return "wide"


@dataclass
class ApiProcessMetrics:
    online: bool = False
    pid: Optional[int] = None
    started_at: Optional[str] = None
    uptime: Optional[str] = None
    uptime_seconds: Optional[int] = None
    commit: Optional[str] = None
    python: Optional[str] = None
    threads: Optional[int] = None
    log_level: Optional[LogLevel] = None
    log_buffer_capacity: Optional[int] = None
    log_buffer_last_seq: Optional[int] = None
    supervised: bool = False

    def __post_init__(self) -> None:
        if self.uptime_seconds is not None:
            self.uptime_seconds = max(0, int(self.uptime_seconds))
        if self.commit is not None:
            self.commit = sanitize_log_text(self.commit, preserve_newlines=False)
        if self.log_level is not None and self.log_level not in LOG_LEVELS:
            self.log_level = "INFO"


@dataclass
class DiskMetrics:
    path: str = "."
    total_gb: float = 0.0
    free_gb: float = 0.0
    used_percent: float = 0.0

    def __post_init__(self) -> None:
        self.total_gb = max(0.0, float(self.total_gb))
        self.free_gb = max(0.0, float(self.free_gb))
        self.used_percent = max(0.0, min(100.0, float(self.used_percent)))


@dataclass
class MachineMetrics:
    host: str = "—"
    platform: str = "—"
    cpus: Optional[int] = None
    load: Optional[tuple[float, float, float]] = None
    system_total_mb: Optional[float] = None
    system_available_mb: Optional[float] = None
    api_rss_mb: Optional[float] = None
    api_peak_mb: Optional[float] = None
    disk: Optional[DiskMetrics] = None

    def __post_init__(self) -> None:
        self.host = sanitize_log_text(self.host, preserve_newlines=False) or "—"
        self.platform = sanitize_log_text(self.platform, preserve_newlines=False) or "—"


@dataclass
class GpuModelInfo:
    name: str
    size_gb: float = 0.0
    in_use: int = 0

    def __post_init__(self) -> None:
        self.name = sanitize_log_text(self.name, preserve_newlines=False)


@dataclass
class GpuQueueState:
    slots: int = 0
    running: int = 0
    waiting: int = 0

    def __post_init__(self) -> None:
        self.slots = max(0, int(self.slots))
        self.running = max(0, min(self.slots, int(self.running)) if self.slots else max(0, int(self.running)))
        self.waiting = max(0, int(self.waiting))


@dataclass
class GpuMetrics:
    available: bool = False
    name: Optional[str] = None
    total_gb: Optional[float] = None
    free_gb: Optional[float] = None
    allocated_gb: Optional[float] = None
    peak_gb: Optional[float] = None
    utilization_pct: Optional[float] = None
    budget_gb: Optional[float] = None
    queue: Optional[GpuQueueState] = None
    models: list[GpuModelInfo] = field(default_factory=list)
    error: Optional[str] = None

    def __post_init__(self) -> None:
        if self.name is not None:
            self.name = sanitize_log_text(self.name, preserve_newlines=False)
        if self.error is not None:
            self.error = sanitize_log_text(self.error, preserve_newlines=False)


@dataclass
class BackgroundWorkMetrics:
    notifications: Optional[bool] = None
    support_inbox: Optional[bool] = None
    checks_since_start: int = 0
    failed_since_start: int = 0
    auto_restart: Literal["Supervisor", "Manual"] = "Manual"


@dataclass
class ManagedServiceInfo:
    name: str
    state: str = "UNKNOWN"
    pid: Optional[int] = None
    uptime: Optional[str] = None
    detail: str = ""

    def __post_init__(self) -> None:
        self.name = sanitize_log_text(self.name, preserve_newlines=False)
        raw_state = sanitize_log_text(self.state, preserve_newlines=False).upper()
        self.state = raw_state if raw_state in ("RUNNING", "STARTING", "STOPPED", "FATAL", "BACKOFF", "EXITED", "UNKNOWN") else "UNKNOWN"
        self.detail = sanitize_log_text(self.detail, preserve_newlines=False)


@dataclass
class VerificationCheck:
    job_id: str
    input_type: str = "pdf"
    input_name: Optional[str] = None
    user_id: Optional[str] = None
    status: Literal["queued", "processing", "completed", "failed"] = "queued"
    progress: int = 0
    current_step: str = "queued"
    message: str = ""
    error: Optional[str] = None
    age_seconds: float = 0.0
    step_seconds: float = 0.0
    updated_at: str = ""

    def __post_init__(self) -> None:
        self.job_id = sanitize_log_text(self.job_id, preserve_newlines=False)
        self.input_type = sanitize_log_text(self.input_type, preserve_newlines=False) or "text"
        if self.input_name is not None:
            self.input_name = sanitize_log_text(self.input_name, preserve_newlines=False)
        if self.status not in ("queued", "processing", "completed", "failed"):
            self.status = "queued"
        self.progress = max(0, min(100, int(self.progress)))
        self.current_step = sanitize_log_text(self.current_step, preserve_newlines=False)
        self.message = sanitize_log_text(self.message, preserve_newlines=False)
        if self.error is not None:
            self.error = sanitize_log_text(self.error, preserve_newlines=False)


@dataclass
class ServerSnapshot:
    checked_at: str = ""
    received_at_mono: float = field(default_factory=time.monotonic)
    mode: OperatingMode = "local"
    api: ApiProcessMetrics = field(default_factory=ApiProcessMetrics)
    machine: MachineMetrics = field(default_factory=MachineMetrics)
    gpu: GpuMetrics = field(default_factory=GpuMetrics)
    background: BackgroundWorkMetrics = field(default_factory=BackgroundWorkMetrics)
    services: list[ManagedServiceInfo] = field(default_factory=list)
    active_checks: list[VerificationCheck] = field(default_factory=list)
    recent_checks: list[VerificationCheck] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)


@dataclass
class LogEntry:
    key: str
    seq: int
    ts: Optional[float] = None
    ts_text: str = "--:--:--"
    level: str = "INFO"
    levelno: int = logging.INFO
    logger: str = "-"
    message: str = ""
    exc: Optional[str] = None
    job: Optional[str] = None
    request: Optional[str] = None
    user: Optional[str] = None
    raw_line: Optional[str] = None

    def __post_init__(self) -> None:
        self.seq = max(1, int(self.seq))
        self.logger = sanitize_log_text(self.logger, preserve_newlines=False) or "-"
        self.message = sanitize_log_text(self.message, preserve_newlines=True)
        if self.exc is not None:
            self.exc = sanitize_log_text(self.exc, preserve_newlines=True)
        if self.raw_line is not None:
            self.raw_line = sanitize_log_text(self.raw_line, preserve_newlines=True)


@dataclass
class LogFileDescriptor:
    name: LogSourceId
    file: str
    description: str = ""
    exists: bool = False
    size_bytes: int = 0
    modified_at: Optional[str] = None

    def __post_init__(self) -> None:
        self.size_bytes = max(0, int(self.size_bytes))


@dataclass
class LogFilterState:
    min_level: LogLevel = "DEBUG"
    q: str = ""
    job: str = ""
    request: str = ""
    user_id: str = ""

    def __post_init__(self) -> None:
        if self.min_level not in LOG_LEVELS:
            self.min_level = "DEBUG"
        self.q = sanitize_log_text(self.q, preserve_newlines=False).strip()[:200]
        self.job = sanitize_log_text(self.job, preserve_newlines=False).strip()[:40]
        self.request = sanitize_log_text(self.request, preserve_newlines=False).strip()[:16]
        self.user_id = sanitize_log_text(self.user_id, preserve_newlines=False).strip()[:40]

    def has_active_filters(self) -> bool:
        return bool(self.q or self.job or self.request or self.user_id or self.min_level != "DEBUG")

    def to_wire_dict(self) -> dict[str, str]:
        return {
            "level": self.min_level,
            "q": self.q,
            "job": self.job,
            "request": self.request,
            "user_id": self.user_id,
        }


def parse_search_query(raw: str) -> tuple[str, dict[str, str]]:
    """Extract inline `job:`, `req:`, and `user:` tokens from search input."""
    clean = sanitize_log_text(raw, preserve_newlines=False).strip()[:200]
    tags: dict[str, str] = {}
    free_parts: list[str] = []
    for token in clean.split():
        lowered = token.lower()
        if lowered.startswith("job:") and len(token) > 4:
            tags["job"] = token[4:][:40]
        elif lowered.startswith("req:") and len(token) > 4:
            tags["request"] = token[4:][:16]
        elif lowered.startswith("request:") and len(token) > 8:
            tags["request"] = token[8:][:16]
        elif lowered.startswith("user:") and len(token) > 5:
            tags["user_id"] = token[5:][:40]
        else:
            free_parts.append(token)
    return " ".join(free_parts)[:200], tags


@dataclass
class ActionRequest:
    action: str
    service: Optional[ManagedServiceName] = None
    level: Optional[LogLevel] = None
    force: bool = False

    def __post_init__(self) -> None:
        if self.action not in ALLOWED_ACTIONS:
            raise ValueError(f"Unsupported action: {self.action!r}")
        if self.action in ("restart-service", "stop-service", "start-service") and self.service not in MANAGED_SERVICES:
            raise ValueError(f"Action {self.action!r} requires an allowlisted service.")
        if self.action == "log-level" and self.level not in LOG_LEVELS:
            raise ValueError("log-level action requires a valid LogLevel.")


@dataclass
class ActionOutcome:
    ok: bool
    action: str
    summary: str
    status_code: Optional[int] = None
    lost_checks: int = 0
    ms: int = 0

    def __post_init__(self) -> None:
        self.summary = sanitize_log_text(self.summary, preserve_newlines=False)
        self.lost_checks = max(0, int(self.lost_checks))
        self.ms = max(0, int(self.ms))


@dataclass
class RemoteSessionCache:
    api_url: str
    supabase_url: str
    access_token: str
    refresh_token: str
    expires_at: float
    email: str = ""
    user_id: str = ""


@dataclass
class DashboardViewState:
    mode: OperatingMode = "local"
    connection_state: ConnectionState = "connecting"
    breakpoint: ViewportBreakpoint = "medium"
    focused_pane: PaneId = "logs"
    zoomed_pane: Optional[PaneId] = None
    selected_log_source: LogSourceId = "live"
    filters: LogFilterState = field(default_factory=LogFilterState)
    paused: bool = False
    unread_while_paused: int = 0
    truncated_notice: bool = False
    expanded_tracebacks: set[str] = field(default_factory=set)
    last_api_pid: Optional[int] = None
    stale: bool = False


class LogStore:
    """Bounded FIFO ring buffer (`maxlen=3000`) with client-side filter matching."""

    def __init__(self, capacity: int = 3000) -> None:
        self.capacity = max(1, int(capacity))
        self._entries: deque[LogEntry] = deque(maxlen=self.capacity)
        self._keys: set[str] = set()
        self.last_seq: int = 0
        self.dropped_count: int = 0

    def __len__(self) -> int:
        return len(self._entries)

    def clear(self) -> None:
        self._entries.clear()
        self._keys.clear()
        self.last_seq = 0
        self.dropped_count = 0

    def append(self, entry: LogEntry) -> bool:
        if entry.key in self._keys:
            return False
        if len(self._entries) == self._entries.maxlen:
            evicted = self._entries[0]
            self._keys.discard(evicted.key)
            self.dropped_count += 1
        self._entries.append(entry)
        self._keys.add(entry.key)
        self.last_seq = max(self.last_seq, entry.seq)
        return True

    def extend(self, entries: list[LogEntry]) -> list[LogEntry]:
        added: list[LogEntry] = []
        for entry in entries:
            if self.append(entry):
                added.append(entry)
        return added

    def replace_all(self, entries: list[LogEntry]) -> None:
        self.clear()
        self.extend(entries)

    def all_entries(self) -> list[LogEntry]:
        return list(self._entries)

    @staticmethod
    def matches(entry: LogEntry, filters: LogFilterState) -> bool:
        min_no = LOG_LEVEL_VALUES.get(filters.min_level, logging.DEBUG)
        if entry.levelno < min_no:
            return False
        if filters.job and not (entry.job or "").startswith(filters.job):
            return False
        if filters.request and entry.request != filters.request:
            return False
        if filters.user_id and not (entry.user or "").startswith(filters.user_id):
            return False
        if filters.q:
            needle = filters.q.lower()
            if (
                needle not in entry.message.lower()
                and needle not in (entry.exc or "").lower()
                and needle not in entry.logger.lower()
                and needle not in (entry.raw_line or "").lower()
            ):
                return False
        return True

    def filtered(self, filters: LogFilterState) -> list[LogEntry]:
        return [e for e in self._entries if self.matches(e, filters)]


def _parse_check(raw: dict[str, Any]) -> VerificationCheck:
    return VerificationCheck(
        job_id=str(raw.get("job_id") or "-"),
        input_type=str(raw.get("input_type") or "text"),
        input_name=raw.get("input_name"),
        user_id=raw.get("user_id"),
        status=raw.get("status") or "queued",  # type: ignore[arg-type]
        progress=_as_int(raw.get("progress"), 0) or 0,
        current_step=str(raw.get("current_step") or "-"),
        message=str(raw.get("message") or ""),
        error=raw.get("error"),
        age_seconds=_as_float(raw.get("age_seconds"), 0.0) or 0.0,
        step_seconds=_as_float(raw.get("step_seconds"), 0.0) or 0.0,
        updated_at=str(raw.get("updated_at") or ""),
    )


def _parse_services(raw_list: Any) -> list[ManagedServiceInfo]:
    if not isinstance(raw_list, list):
        return []
    services: list[ManagedServiceInfo] = []
    for item in raw_list:
        if not isinstance(item, dict):
            continue
        services.append(
            ManagedServiceInfo(
                name=str(item.get("name") or "?"),
                state=str(item.get("state") or "UNKNOWN"),
                pid=_as_int(item.get("pid")),
                uptime=item.get("uptime"),
                detail=str(item.get("detail") or ""),
            )
        )
    return services


def snapshot_from_api_payload(
    payload: dict[str, Any],
    *,
    mode: OperatingMode = "remote",
    received_at_mono: Optional[float] = None,
) -> ServerSnapshot:
    """Convert `/api/admin/server` or WS `status` JSON into a typed ServerSnapshot."""
    proc = payload.get("process") or {}
    host = payload.get("host") or {}
    mem = payload.get("memory") or {}
    gpu_raw = payload.get("gpu") or {}
    bg = payload.get("background") or {}
    jobs = payload.get("jobs") or {}
    disk_raw = host.get("disk")

    raw_load = host.get("load")
    load_tuple: Optional[tuple[float, float, float]] = None
    if isinstance(raw_load, (list, tuple)) and len(raw_load) >= 3:
        vals = [_as_float(v) for v in raw_load[:3]]
        if all(v is not None for v in vals):
            load_tuple = (vals[0], vals[1], vals[2])  # type: ignore[index]

    disk = None
    if isinstance(disk_raw, dict):
        disk = DiskMetrics(
            path=str(disk_raw.get("path") or "."),
            total_gb=_as_float(disk_raw.get("total_gb"), 0.0) or 0.0,
            free_gb=_as_float(disk_raw.get("free_gb"), 0.0) or 0.0,
            used_percent=_as_float(disk_raw.get("used_percent"), 0.0) or 0.0,
        )

    queue_raw = gpu_raw.get("queue") or {}
    queue = None
    if isinstance(queue_raw, dict) and queue_raw:
        queue = GpuQueueState(
            slots=_as_int(queue_raw.get("slots"), 0) or 0,
            running=_as_int(queue_raw.get("running"), 0) or 0,
            waiting=_as_int(queue_raw.get("waiting"), 0) or 0,
        )

    models = [
        GpuModelInfo(
            name=str(m.get("name") or "?"),
            size_gb=_as_float(m.get("size_gb"), 0.0) or 0.0,
            in_use=_as_int(m.get("in_use"), 0) or 0,
        )
        for m in (gpu_raw.get("models") or [])
        if isinstance(m, dict)
    ]

    counts = {str(k): int(v) for k, v in (jobs.get("counts") or {}).items() if isinstance(v, (int, float))}
    active_list = [_parse_check(j) for j in (jobs.get("active") or []) if isinstance(j, dict)]
    recent_list = [_parse_check(j) for j in (jobs.get("recent") or []) if isinstance(j, dict)]

    supervised = bool(proc.get("supervised", False))
    completed = counts.get("completed", 0)
    failed = counts.get("failed", 0)
    checks_since_start = counts.get("total", completed + failed + len(active_list))

    log_buf = proc.get("log_buffer") or {}
    return ServerSnapshot(
        checked_at=str(payload.get("checked_at") or ""),
        received_at_mono=time.monotonic() if received_at_mono is None else received_at_mono,
        mode=mode,
        api=ApiProcessMetrics(
            online=True,
            pid=_as_int(proc.get("pid")),
            started_at=proc.get("started_at"),
            uptime=proc.get("uptime"),
            uptime_seconds=_as_int(proc.get("uptime_seconds")),
            commit=proc.get("commit"),
            python=proc.get("python"),
            threads=_as_int(proc.get("threads")),
            log_level=proc.get("log_level"),
            log_buffer_capacity=_as_int(log_buf.get("capacity")),
            log_buffer_last_seq=_as_int(log_buf.get("last_seq")),
            supervised=supervised,
        ),
        machine=MachineMetrics(
            host=str(host.get("name") or "—"),
            platform=str(host.get("platform") or "—"),
            cpus=_as_int(host.get("cpus")),
            load=load_tuple,
            system_total_mb=_as_float(mem.get("system_total_mb")),
            system_available_mb=_as_float(mem.get("system_available_mb")),
            api_rss_mb=_as_float(mem.get("rss_mb")),
            api_peak_mb=_as_float(mem.get("peak_mb")),
            disk=disk,
        ),
        gpu=GpuMetrics(
            available=bool(gpu_raw.get("available", False)),
            name=gpu_raw.get("name"),
            total_gb=_as_float(gpu_raw.get("total_gb")),
            free_gb=_as_float(gpu_raw.get("free_gb")),
            allocated_gb=_as_float(gpu_raw.get("allocated_gb")),
            peak_gb=_as_float(gpu_raw.get("peak_gb")),
            budget_gb=_as_float(gpu_raw.get("budget_gb")),
            queue=queue,
            models=models,
            error=gpu_raw.get("error"),
        ),
        background=BackgroundWorkMetrics(
            notifications=bool(bg["notifications"]) if "notifications" in bg else None,
            support_inbox=bool(bg["support_inbox"]) if "support_inbox" in bg else None,
            checks_since_start=checks_since_start,
            failed_since_start=failed,
            auto_restart="Supervisor" if supervised else "Manual",
        ),
        services=_parse_services(payload.get("services")),
        active_checks=active_list,
        recent_checks=recent_list,
        counts=counts,
    )


def merge_local_and_api_snapshot(
    local_snap: ServerSnapshot,
    api_payload: Optional[dict[str, Any]],
    *,
    api_online: bool,
    received_at_mono: Optional[float] = None,
) -> ServerSnapshot:
    """Apply `data-model.md` §2.2 merge precedence onto the always-on local snapshot."""
    now_mono = time.monotonic() if received_at_mono is None else received_at_mono
    if not api_online or not api_payload:
        supervised = local_snap.api.supervised or bool(local_snap.services)
        return ServerSnapshot(
            checked_at=local_snap.checked_at,
            received_at_mono=now_mono,
            mode="local",
            api=ApiProcessMetrics(online=False, supervised=supervised),
            machine=MachineMetrics(
                host=local_snap.machine.host,
                platform=local_snap.machine.platform,
                cpus=local_snap.machine.cpus,
                load=local_snap.machine.load,
                system_total_mb=local_snap.machine.system_total_mb,
                system_available_mb=local_snap.machine.system_available_mb,
                api_rss_mb=None,
                api_peak_mb=None,
                disk=local_snap.machine.disk,
            ),
            gpu=local_snap.gpu,
            background=BackgroundWorkMetrics(
                notifications=None,
                support_inbox=None,
                checks_since_start=0,
                failed_since_start=0,
                auto_restart="Supervisor" if supervised else "Manual",
            ),
            services=local_snap.services,
            active_checks=[],
            recent_checks=local_snap.recent_checks,
            counts={},
        )

    api_snap = snapshot_from_api_payload(api_payload, mode="local", received_at_mono=now_mono)
    # Local host collector wins for host/RAM/disk/nvidia-smi hardware telemetry and local supervisor list.
    merged_machine = MachineMetrics(
        host=local_snap.machine.host if local_snap.machine.host != "—" else api_snap.machine.host,
        platform=local_snap.machine.platform if local_snap.machine.platform != "—" else api_snap.machine.platform,
        cpus=local_snap.machine.cpus if local_snap.machine.cpus is not None else api_snap.machine.cpus,
        load=local_snap.machine.load if local_snap.machine.load is not None else api_snap.machine.load,
        system_total_mb=(
            local_snap.machine.system_total_mb
            if local_snap.machine.system_total_mb is not None
            else api_snap.machine.system_total_mb
        ),
        system_available_mb=(
            local_snap.machine.system_available_mb
            if local_snap.machine.system_available_mb is not None
            else api_snap.machine.system_available_mb
        ),
        api_rss_mb=api_snap.machine.api_rss_mb,
        api_peak_mb=api_snap.machine.api_peak_mb,
        disk=local_snap.machine.disk or api_snap.machine.disk,
    )

    gpu_available = local_snap.gpu.available or api_snap.gpu.available
    merged_gpu = GpuMetrics(
        available=gpu_available,
        name=local_snap.gpu.name or api_snap.gpu.name,
        total_gb=local_snap.gpu.total_gb if local_snap.gpu.total_gb is not None else api_snap.gpu.total_gb,
        free_gb=local_snap.gpu.free_gb if local_snap.gpu.free_gb is not None else api_snap.gpu.free_gb,
        allocated_gb=api_snap.gpu.allocated_gb,
        peak_gb=api_snap.gpu.peak_gb,
        utilization_pct=local_snap.gpu.utilization_pct,
        budget_gb=api_snap.gpu.budget_gb,
        queue=api_snap.gpu.queue,
        models=api_snap.gpu.models,
        error=api_snap.gpu.error or local_snap.gpu.error,
    )

    services = local_snap.services if local_snap.services else api_snap.services
    supervised = api_snap.api.supervised or local_snap.api.supervised or bool(services)
    api_snap.api.supervised = supervised
    api_snap.background.auto_restart = "Supervisor" if supervised else "Manual"

    return ServerSnapshot(
        checked_at=api_snap.checked_at or local_snap.checked_at,
        received_at_mono=now_mono,
        mode="local",
        api=api_snap.api,
        machine=merged_machine,
        gpu=merged_gpu,
        background=api_snap.background,
        services=services,
        active_checks=api_snap.active_checks,
        recent_checks=api_snap.recent_checks,
        counts=api_snap.counts,
    )
