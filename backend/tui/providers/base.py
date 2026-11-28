"""Abstract provider protocol and event contracts for the Etymos TUI."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable, Optional, Protocol

from ..models import (
    ActionOutcome,
    ActionRequest,
    CommandRequest,
    CommandStatus,
    CommandStreamKind,
    ConnectionState,
    LogEntry,
    LogFileDescriptor,
    LogFilterState,
    LogSourceId,
    OperatingMode,
    ServerSnapshot,
)
from ..sanitize import sanitize_log_text


@dataclass
class SnapshotEvent:
    snapshot: ServerSnapshot


@dataclass
class ConnectionEvent:
    state: ConnectionState
    detail: str = ""


@dataclass
class LogSnapshotEvent:
    source: LogSourceId
    rows: list[LogEntry]
    truncated: bool = False
    last_seq: int = 0
    pid: Optional[int] = None


@dataclass
class LogRowsEvent:
    source: LogSourceId
    rows: list[LogEntry]
    truncated: bool = False
    last_seq: int = 0
    pid: Optional[int] = None


@dataclass
class LogFilesEvent:
    files: list[LogFileDescriptor]


@dataclass
class NoticeEvent:
    message: str
    severity: str = "information"


@dataclass
class AuthErrorEvent:
    detail: str


@dataclass
class CommandStartedEvent:
    run_id: str
    cwd: str = ""

    def __post_init__(self) -> None:
        self.cwd = sanitize_log_text(self.cwd, preserve_newlines=False)


@dataclass
class CommandOutputEvent:
    run_id: str
    stream: CommandStreamKind
    data: str

    def __post_init__(self) -> None:
        self.data = sanitize_log_text(self.data, preserve_newlines=True)


@dataclass
class CommandDoneEvent:
    run_id: str
    status: CommandStatus
    exit_code: Optional[int] = None
    duration_ms: int = 0
    truncated: bool = False
    error: Optional[str] = None

    def __post_init__(self) -> None:
        self.duration_ms = max(0, int(self.duration_ms))
        if self.error is not None:
            self.error = sanitize_log_text(self.error, preserve_newlines=False)


ProviderEvent = (
    SnapshotEvent
    | ConnectionEvent
    | LogSnapshotEvent
    | LogRowsEvent
    | LogFilesEvent
    | NoticeEvent
    | AuthErrorEvent
    | CommandStartedEvent
    | CommandOutputEvent
    | CommandDoneEvent
)

EventEmitFn = Callable[[ProviderEvent], None]


class DashboardProvider(Protocol):
    """Unified interface implemented by LocalDashboardProvider, RemoteDashboardProvider, and test fakes."""

    mode: OperatingMode
    target_label: str

    async def start(self, emit: EventEmitFn) -> None:
        ...

    async def stop(self) -> None:
        ...

    async def request_refresh(self) -> None:
        ...

    async def set_log_source(self, source: LogSourceId) -> None:
        ...

    async def set_log_filters(self, filters: LogFilterState) -> None:
        ...

    async def set_log_paused(self, paused: bool, after_seq: int = 0) -> None:
        ...

    async def execute_action(self, req: ActionRequest) -> ActionOutcome:
        ...

    async def run_command(self, req: CommandRequest) -> None:
        ...

    async def cancel_command(self, run_id: str) -> None:
        ...


EmitCallback = Callable[[ProviderEvent], Awaitable[None] | None]
