"""Logging for the API process.

Without this, uvicorn only configures its own loggers: the app's
logger.info() calls were dropped and pipeline print()s went to a separate
file with no timestamps, which made it impossible to tell why a check ended.

configure_logging() (called once, first thing in app.py) gives every line
    2026-11-07 10:23:53.123 +0700 INFO  [job_1a2b3c4d] main: Searching all sources...
i.e. local time with offset, level, the check it belongs to (when it runs on
a check's thread), and the logger name. It also:

- routes print() output through logging (LOG_CAPTURE_PRINTS=0 turns it off),
  so pipeline progress gets a timestamp and job id and lands in the same file;
- logs uncaught exceptions in any thread, and native crashes (segfaults in
  CUDA or PyMuPDF) via faulthandler;
- dumps every thread's stack on `kill -USR1 <api pid>`, for a check that
  seems stuck.

Settings: LOG_LEVEL (default INFO; DEBUG adds every job poll and queue move).
"""
from __future__ import annotations

import faulthandler
import io
import logging
import os
import resource
import signal
import sys
import threading
import time
from contextlib import contextmanager
from typing import Iterator

PROCESS_STARTED = time.time()

_job = threading.local()
_configured = False


def bind_job(job_id: str | None) -> None:
    """Tag this thread's log lines with a check's id (a check runs on its own
    thread, so this lasts until the check ends)."""
    _job.id = job_id


@contextmanager
def job_context(job_id: str) -> Iterator[None]:
    previous = getattr(_job, "id", None)
    _job.id = job_id
    try:
        yield
    finally:
        _job.id = previous


def short_job(job_id: str | None) -> str:
    """job_<32 hex> -> job_<first 8>: enough to grep, short enough to read."""
    if not job_id:
        return "-"
    return job_id[:12] if job_id.startswith("job_") else job_id[:8]


class _JobFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        job_id = getattr(_job, "id", None)
        record.job = f"[{short_job(job_id)}] " if job_id else ""
        return True


class _Formatter(logging.Formatter):
    def formatTime(self, record: logging.LogRecord, datefmt: str | None = None) -> str:  # noqa: N802
        t = time.localtime(record.created)
        return f"{time.strftime('%Y-%m-%d %H:%M:%S', t)}.{int(record.msecs):03d} {time.strftime('%z', t)}"


FORMAT = "%(asctime)s %(levelname)-5s %(job)s%(name)s: %(message)s"


class _PrintToLog(io.TextIOBase):
    """sys.stdout replacement: each printed line becomes a log record."""

    def __init__(self, original, logger: logging.Logger):
        self._original = original
        self._logger = logger
        self._pending = threading.local()

    def writable(self) -> bool:
        return True

    def write(self, text: str) -> int:
        buf = getattr(self._pending, "text", "") + text
        *lines, rest = buf.split("\n")
        self._pending.text = rest
        for line in lines:
            if line.strip():
                self._logger.info(line.rstrip())
        return len(text)

    def flush(self) -> None:
        rest = getattr(self._pending, "text", "")
        if rest.strip():
            self._pending.text = ""
            self._logger.info(rest.rstrip())

    # Libraries that need a real stream (fileno, binary buffer) get the original.
    def fileno(self) -> int:
        return self._original.fileno()

    @property
    def buffer(self):
        return self._original.buffer

    @property
    def encoding(self):  # type: ignore[override]
        return getattr(self._original, "encoding", "utf-8")

    def isatty(self) -> bool:
        return False


def configure_logging() -> None:
    global _configured
    # Under pytest, logging belongs to pytest (its captured stderr is closed
    # at exit, which a handler of ours would then write to).
    if _configured or "pytest" in sys.modules:
        return
    _configured = True

    level = getattr(logging, os.getenv("LOG_LEVEL", "INFO").strip().upper(), logging.INFO)
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(_Formatter(FORMAT))
    handler.addFilter(_JobFilter())

    root = logging.getLogger()
    root.setLevel(level)
    for old in list(root.handlers):
        root.removeHandler(old)
    root.addHandler(handler)

    # uvicorn set up its own handlers before importing the app; send its lines
    # through ours so they get the same timestamp. Its access log is replaced
    # by the request log in app.py (which adds timings and skips job polls).
    for name in ("uvicorn", "uvicorn.error"):
        lg = logging.getLogger(name)
        lg.handlers.clear()
        lg.propagate = True
    access = logging.getLogger("uvicorn.access")
    access.handlers.clear()
    access.propagate = False
    # Chatty at INFO: one line per HTTP call to Supabase, Gemini, model hubs.
    for name in ("httpx", "httpcore", "urllib3", "hpack", "filelock", "PIL", "matplotlib"):
        logging.getLogger(name).setLevel(max(level, logging.WARNING))

    if os.getenv("LOG_CAPTURE_PRINTS", "1").strip().lower() not in ("0", "false", "no"):
        sys.stdout = _PrintToLog(sys.stdout, logging.getLogger("print"))

    log = logging.getLogger("api.process")

    def thread_hook(args: threading.ExceptHookArgs) -> None:
        if args.exc_type is SystemExit:
            return
        log.critical("Uncaught exception in thread %s",
                     args.thread.name if args.thread else "?",
                     exc_info=(args.exc_type, args.exc_value, args.exc_traceback))

    def process_hook(exc_type, exc_value, exc_tb) -> None:
        log.critical("Uncaught exception", exc_info=(exc_type, exc_value, exc_tb))

    threading.excepthook = thread_hook
    sys.excepthook = process_hook

    try:
        faulthandler.enable(file=sys.stderr, all_threads=True)
        if hasattr(signal, "SIGUSR1"):
            faulthandler.register(signal.SIGUSR1, file=sys.stderr, all_threads=True)
    except (RuntimeError, ValueError, io.UnsupportedOperation):
        log.warning("faulthandler unavailable; native crashes won't print a stack")


# --- Memory -----------------------------------------------------------------

def _meminfo_kb(field: str) -> int | None:
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith(field + ":"):
                    return int(line.split()[1])
    except OSError:
        pass
    return None


def _rss_mb() -> float | None:
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) / 1024
    except OSError:
        pass
    return None


def memory_summary() -> str:
    """RAM of this process (now and peak), free RAM on the machine, and GPU
    memory if torch is loaded: what an out-of-memory crash would show."""
    parts = []
    rss = _rss_mb()
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    peak_mb = peak / (1024 * 1024) if sys.platform == "darwin" else peak / 1024
    parts.append(f"rss={rss:.0f}MB" if rss is not None else "rss=?")
    parts.append(f"peak={peak_mb:.0f}MB")
    available = _meminfo_kb("MemAvailable")
    if available is not None:
        parts.append(f"sys_free={available / 1024:.0f}MB")
    torch = sys.modules.get("torch")
    if torch is not None:
        try:
            if torch.cuda.is_available() and torch.cuda.is_initialized():
                gb = 1024 ** 3
                free, total = torch.cuda.mem_get_info()
                parts.append(
                    f"gpu_alloc={torch.cuda.memory_allocated() / gb:.2f}GB "
                    f"gpu_peak={torch.cuda.max_memory_allocated() / gb:.2f}GB "
                    f"gpu_free={free / gb:.2f}/{total / gb:.2f}GB"
                )
        except Exception:
            pass
    return " ".join(parts)


def uptime_text() -> str:
    seconds = int(time.time() - PROCESS_STARTED)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}h{m:02d}m{s:02d}s" if h else f"{m}m{s:02d}s"
