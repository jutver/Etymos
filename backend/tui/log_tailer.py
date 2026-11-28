"""Inode- and rotation-aware bounded log file tailer for server log files."""
from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Optional

from .models import LOG_FILE_NAMES, LOG_LEVEL_VALUES, LogEntry, LogFileDescriptor, LogSourceId
from .sanitize import sanitize_log_text

# Match lines emitted by backend/api/log_setup.py:
#   2026-11-07 10:23:53.123 +0700 INFO  [job_1a2b3c4d] logger: message
#   2026-11-07 10:23:53.123 +0700 INFO  [r:ab12cd34 u:11223344] logger: message
_API_LINE_RE = re.compile(
    r"^(?P<date>\d{4}-\d{2}-\d{2})\s+(?P<time>\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+"
    r"(?:[+-]\d{4}\s+)?(?P<level>DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL)\s+"
    r"(?:\[(?P<tags>[^\]]+)\]\s+)?(?P<logger>[A-Za-z0-9_.\-]+):\s*(?P<msg>.*)$"
)
# Also recognize plain timestamp prefix from deploy_watch.sh / autostart.log:
#   2026-11-07 10:23:53 message
_PLAIN_TS_RE = re.compile(r"^(?P<date>\d{4}-\d{2}-\d{2})[T\s](?P<time>\d{2}:\d{2}:\d{2}(?:\.\d+)?)\S*\s+(?P<msg>.*)$")

TAIL_BYTES = 4 * 1024 * 1024


def parse_log_file_line(
    raw_line: str,
    *,
    source: LogSourceId,
    line_no: int,
) -> LogEntry:
    """Convert a raw log file line into a sanitized LogEntry."""
    clean = sanitize_log_text(raw_line, preserve_newlines=False)
    m = _API_LINE_RE.match(clean)
    if m:
        lvl = m.group("level")
        if lvl == "WARN":
            lvl = "WARNING"
        tags = (m.group("tags") or "").strip()
        job = None
        req = None
        user = None
        if tags:
            for part in tags.split():
                if part.startswith("job_"):
                    job = part
                elif part.startswith("r:"):
                    req = part[2:]
                elif part.startswith("u:"):
                    user = part[2:]
        return LogEntry(
            key=f"{source}:{line_no}",
            seq=line_no,
            ts=None,
            ts_text=m.group("time"),
            level=lvl,
            levelno=LOG_LEVEL_VALUES.get(lvl, logging.INFO),
            logger=m.group("logger"),
            message=m.group("msg"),
            job=job,
            request=req,
            user=user,
            raw_line=clean,
        )

    plain = _PLAIN_TS_RE.match(clean)
    if plain:
        return LogEntry(
            key=f"{source}:{line_no}",
            seq=line_no,
            ts=None,
            ts_text=plain.group("time"),
            level="RAW",
            levelno=logging.INFO,
            logger=source,
            message=plain.group("msg"),
            raw_line=clean,
        )

    return LogEntry(
        key=f"{source}:{line_no}",
        seq=line_no,
        ts=None,
        ts_text="--:--:--",
        level="RAW",
        levelno=logging.INFO,
        logger=source,
        message=clean,
        raw_line=clean,
    )


class LocalLogFileTailer:
    """Tracks bounded initial tails + incremental appends across file rotations."""

    def __init__(self, log_dir: Path, initial_lines: int = 400) -> None:
        self.log_dir = Path(log_dir)
        self.initial_lines = max(1, initial_lines)
        self._cursors: dict[LogSourceId, tuple[Optional[int], int, int]] = {}
        # source -> (inode, byte_offset, next_seq)

    def describe_files(self) -> list[LogFileDescriptor]:
        out: list[LogFileDescriptor] = []
        for name, (filename, desc) in LOG_FILE_NAMES.items():
            path = self.log_dir / filename
            try:
                st = path.stat()
                out.append(
                    LogFileDescriptor(
                        name=name,  # type: ignore[arg-type]
                        file=filename,
                        description=desc,
                        exists=True,
                        size_bytes=st.st_size,
                        modified_at=None,
                    )
                )
            except OSError:
                out.append(
                    LogFileDescriptor(
                        name=name,  # type: ignore[arg-type]
                        file=filename,
                        description=desc,
                        exists=False,
                        size_bytes=0,
                    )
                )
        return out

    def reset_source(self, source: LogSourceId) -> None:
        self._cursors.pop(source, None)

    def read_initial(self, source: LogSourceId) -> tuple[list[LogEntry], bool]:
        """Load up to `initial_lines` from the end of `source` and record cursor."""
        if source not in LOG_FILE_NAMES:
            return [], False
        path = self.log_dir / LOG_FILE_NAMES[source][0]
        try:
            st = path.stat()
        except OSError:
            self._cursors[source] = (None, 0, 1)
            return [], False

        size = st.st_size
        start = max(0, size - TAIL_BYTES)
        with path.open("rb") as fh:
            fh.seek(start)
            data = fh.read()
            end_pos = fh.tell()

        rows = data.decode("utf-8", errors="replace").splitlines()
        if start > 0 and rows:
            rows = rows[1:]
        truncated = start > 0 or len(rows) > self.initial_lines
        tail = rows[-self.initial_lines :]

        entries: list[LogEntry] = []
        seq = 1
        for line in tail:
            entries.append(parse_log_file_line(line, source=source, line_no=seq))
            seq += 1

        self._cursors[source] = (st.st_ino, end_pos, seq)
        return entries, truncated

    def poll_appends(self, source: LogSourceId) -> tuple[list[LogEntry], bool]:
        """Return `(new_entries, reset_required)`.

        If rotation or truncation is detected, returns `read_initial` with `reset_required=True`.
        """
        if source not in LOG_FILE_NAMES:
            return [], False
        path = self.log_dir / LOG_FILE_NAMES[source][0]
        cursor = self._cursors.get(source)
        if cursor is None:
            entries, _ = self.read_initial(source)
            return entries, True

        prev_ino, prev_offset, next_seq = cursor
        try:
            st = path.stat()
        except OSError:
            if prev_ino is not None:
                self._cursors[source] = (None, 0, 1)
                return [], True
            return [], False

        # Detect newly created file, inode replacement (logrotate), or truncation.
        if prev_ino is None or st.st_ino != prev_ino or st.st_size < prev_offset:
            entries, _ = self.read_initial(source)
            return entries, True

        if st.st_size == prev_offset:
            return [], False

        with path.open("rb") as fh:
            fh.seek(prev_offset)
            data = fh.read()
            end_pos = fh.tell()

        text = data.decode("utf-8", errors="replace")
        # If file ends mid-line without newline, keep offset at last newline cleanly
        last_nl = text.rfind("\n")
        if last_nl == -1:
            return [], False
        complete_text = text[: last_nl + 1]
        bytes_consumed = len(complete_text.encode("utf-8", errors="replace"))
        new_offset = min(end_pos, prev_offset + bytes_consumed)

        entries: list[LogEntry] = []
        for line in complete_text.splitlines():
            entries.append(parse_log_file_line(line, source=source, line_no=next_seq))
            next_seq += 1

        self._cursors[source] = (st.st_ino, new_offset, next_seq)
        return entries, False
