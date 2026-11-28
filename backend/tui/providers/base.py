"""Abstract provider protocol and event contracts for the Etymos TUI."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable, Optional, Protocol

from ..models import (
    ActionOutcome,
    ActionRequest,
    ConnectionState,
    LogEntry,
    LogFileDescriptor,
    LogFilterState,
    LogSourceId,
    OperatingMode,
    ServerSnapshot,
)


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


ProviderEvent = (
    SnapshotEvent
    | ConnectionEvent
    | LogSnapshotEvent
    | LogRowsEvent
    | LogFilesEvent
    | NoticeEvent
    | AuthErrorEvent
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


EmitCallback = Callable[[ProviderEvent], Awaitable[None] | None]
