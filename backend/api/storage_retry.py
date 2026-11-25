"""
storage_retry.py
----------------
Transient-error classification, bounded inline retries, and a durable
disk-backed background retry queue for Supabase Storage operations.
"""

from __future__ import annotations

import json
import logging
import os
import random
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional, TypeVar

import httpcore
import httpx

logger = logging.getLogger(__name__)

T = TypeVar("T")

DEFAULT_STORAGE_RETRY_ATTEMPTS = max(1, int(os.getenv("SUPABASE_STORAGE_UPLOAD_ATTEMPTS", "4")))
DEFAULT_STORAGE_RETRY_BASE_SECONDS = max(0.0, float(os.getenv("SUPABASE_STORAGE_RETRY_BASE_SECONDS", "1.0")))
DEFAULT_STORAGE_RETRY_MAX_SECONDS = max(0.0, float(os.getenv("SUPABASE_STORAGE_RETRY_MAX_SECONDS", "8.0")))

PDF_BG_RETRY_INITIAL_SECONDS = max(1.0, float(os.getenv("PDF_BG_RETRY_INITIAL_SECONDS", "15.0")))
PDF_BG_RETRY_MAX_BACKOFF_SECONDS = max(5.0, float(os.getenv("PDF_BG_RETRY_MAX_BACKOFF_SECONDS", "600.0")))
PDF_BG_RETRY_MAX_ATTEMPTS = max(1, int(os.getenv("PDF_BG_RETRY_MAX_ATTEMPTS", "12")))

RETRYABLE_STATUS_CODES = frozenset({408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524})

_TRANSIENT_EXCEPTION_TYPES = (
    httpx.TimeoutException,
    httpx.NetworkError,
    httpx.ProxyError,
    httpx.RemoteProtocolError,
    httpcore.TimeoutException,
    httpcore.NetworkError,
    httpcore.ProxyError,
    httpcore.RemoteProtocolError,
    ConnectionError,
    TimeoutError,
)


def _extract_status_code(exc: BaseException) -> Optional[int]:
    if isinstance(exc, httpx.HTTPStatusError) and exc.response is not None:
        return exc.response.status_code
    for attr in ("status", "status_code"):
        raw = getattr(exc, attr, None)
        if raw is None or isinstance(raw, bool):
            continue
        if isinstance(raw, int):
            return raw
        if isinstance(raw, str):
            stripped = raw.strip()
            if stripped.isdigit():
                return int(stripped)
    return None


def is_transient_storage_error(
    exc: BaseException,
    *,
    _visited: Optional[set[int]] = None,
    _depth: int = 0,
) -> bool:
    """Return True only when a storage failure is likely transient (disconnect,
    timeout, network error, or 408/425/429/5xx HTTP status)."""
    status_code = _extract_status_code(exc)
    if status_code is not None:
        return status_code in RETRYABLE_STATUS_CODES

    if isinstance(exc, _TRANSIENT_EXCEPTION_TYPES):
        return True

    cause = exc.__cause__
    if cause is not None and _depth < 4:
        visited = _visited if _visited is not None else {id(exc)}
        cause_id = id(cause)
        if cause_id not in visited:
            visited.add(cause_id)
            return is_transient_storage_error(cause, _visited=visited, _depth=_depth + 1)

    return False


def run_with_storage_retry(
    operation: Callable[[], T],
    *,
    label: str,
    max_attempts: int = DEFAULT_STORAGE_RETRY_ATTEMPTS,
    base_delay: float = DEFAULT_STORAGE_RETRY_BASE_SECONDS,
    max_delay: float = DEFAULT_STORAGE_RETRY_MAX_SECONDS,
    sleep_fn: Optional[Callable[[float], None]] = None,
    jitter_fn: Optional[Callable[[float, float], float]] = None,
) -> T:
    """Execute a synchronous storage operation with exponential backoff on
    transient errors. Non-transient errors fail immediately without sleeping."""
    attempts = max(1, max_attempts)
    sleep = sleep_fn or time.sleep
    jitter = jitter_fn or random.uniform

    for attempt in range(1, attempts + 1):
        try:
            return operation()
        except Exception as exc:
            if attempt >= attempts or not is_transient_storage_error(exc):
                raise
            delay = min(max_delay, base_delay * (2 ** (attempt - 1)))
            sleep_seconds = delay + jitter(0.0, min(0.5, delay * 0.25)) if delay > 0 else 0.0
            logger.warning(
                "%s failed on attempt %d/%d (%s: %s); retrying in %.2fs",
                label,
                attempt,
                attempts,
                type(exc).__name__,
                exc,
                sleep_seconds,
            )
            if sleep_seconds > 0:
                sleep(sleep_seconds)

    raise AssertionError("Unreachable retry exit")


def _atomic_write_bytes(dest: Path, data: bytes) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f"{dest.name}.tmp")
    try:
        tmp.write_bytes(data)
        os.replace(tmp, dest)
    except BaseException:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def _atomic_write_json(dest: Path, payload: dict[str, Any]) -> None:
    _atomic_write_bytes(dest, json.dumps(payload, separators=(",", ":")).encode("utf-8"))


class PendingPdfUploadQueue:
    """Disk-backed background retry queue for report PDFs whose inline upload
    to Supabase Storage failed transiently."""

    def __init__(
        self,
        *,
        fallback_dir_getter: Callable[[], Path],
        client_getter: Callable[[], Any],
        bucket_getter: Callable[[], str],
        storage_path_fn: Callable[[str, str], str],
        initial_delay: float = PDF_BG_RETRY_INITIAL_SECONDS,
        max_backoff: float = PDF_BG_RETRY_MAX_BACKOFF_SECONDS,
        max_attempts: int = PDF_BG_RETRY_MAX_ATTEMPTS,
        now_fn: Optional[Callable[[], float]] = None,
        jitter_fn: Optional[Callable[[float, float], float]] = None,
    ) -> None:
        self._fallback_dir_getter = fallback_dir_getter
        self._client_getter = client_getter
        self._bucket_getter = bucket_getter
        self._storage_path_fn = storage_path_fn
        self._initial_delay = max(1.0, float(initial_delay))
        self._max_backoff = max(1.0, float(max_backoff))
        self._max_attempts = max(1, int(max_attempts))
        self._now_fn = now_fn
        self._jitter_fn = jitter_fn

        self._lock = threading.Lock()
        self._in_flight: set[str] = set()
        self._cancelled: set[str] = set()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def _now(self) -> float:
        return (self._now_fn or time.time)()

    def _jitter(self, low: float, high: float) -> float:
        return (self._jitter_fn or random.uniform)(low, high)

    def _pdf_path(self, fallback_dir: Path, report_id: str) -> Path:
        return fallback_dir / f"{report_id}.pdf"

    def _meta_path(self, fallback_dir: Path, report_id: str) -> Path:
        return fallback_dir / f"{report_id}.pending.json"

    def save_local_fallback(self, report_id: str, pdf_bytes: bytes) -> Path:
        """Persist PDF bytes locally without queuing a background upload."""
        fallback_dir = Path(self._fallback_dir_getter())
        pdf_path = self._pdf_path(fallback_dir, report_id)
        with self._lock:
            _atomic_write_bytes(pdf_path, pdf_bytes)
        return pdf_path

    def enqueue(
        self,
        user_id: str,
        report_id: str,
        pdf_bytes: bytes,
        *,
        last_error: Optional[str] = None,
    ) -> None:
        """Save PDF bytes and schedule background upload retries."""
        fallback_dir = Path(self._fallback_dir_getter())
        now = self._now()
        payload = {
            "user_id": user_id,
            "report_id": report_id,
            "attempts": 0,
            "next_retry_at": now + self._initial_delay,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "last_error": last_error,
        }
        with self._lock:
            _atomic_write_bytes(self._pdf_path(fallback_dir, report_id), pdf_bytes)
            _atomic_write_json(self._meta_path(fallback_dir, report_id), payload)
            self._cancelled.discard(report_id)
        self._wake.set()

    def cancel(self, report_id: str, *, remove_pdf: bool = False) -> None:
        """Cancel any queued or in-flight upload retry for `report_id`."""
        fallback_dir = Path(self._fallback_dir_getter())
        with self._lock:
            self._meta_path(fallback_dir, report_id).unlink(missing_ok=True)
            if remove_pdf:
                self._pdf_path(fallback_dir, report_id).unlink(missing_ok=True)
            if report_id in self._in_flight:
                self._cancelled.add(report_id)

    def cancel_for_user(self, user_id: str) -> None:
        """Cancel and remove all pending uploads belonging to `user_id`."""
        fallback_dir = Path(self._fallback_dir_getter())
        if not fallback_dir.exists():
            return
        with self._lock:
            for meta_path in sorted(fallback_dir.glob("*.pending.json")):
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                except (OSError, ValueError, TypeError):
                    continue
                if not isinstance(meta, dict) or meta.get("user_id") != user_id:
                    continue
                report_id = str(meta.get("report_id") or "")
                meta_path.unlink(missing_ok=True)
                if report_id:
                    self._pdf_path(fallback_dir, report_id).unlink(missing_ok=True)
                    if report_id in self._in_flight:
                        self._cancelled.add(report_id)

    def process_due_once(self, *, now: Optional[float] = None) -> Optional[float]:
        """Process all pending uploads whose `next_retry_at` has passed.

        Returns the delay in seconds until the earliest remaining pending upload
        is due, or None when no pending uploads remain.
        """
        fallback_dir = Path(self._fallback_dir_getter())
        if not fallback_dir.exists():
            return None

        meta_files = sorted(fallback_dir.glob("*.pending.json"))
        if not meta_files:
            return None

        client = self._client_getter()
        if client is None:
            return 60.0

        current_now = self._now() if now is None else now
        next_wait: Optional[float] = None

        for meta_path in meta_files:
            if self._stop.is_set():
                break

            with self._lock:
                if not meta_path.exists():
                    continue
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                except (OSError, ValueError, TypeError):
                    logger.warning("Removing corrupt pending PDF metadata file %s", meta_path.name)
                    meta_path.unlink(missing_ok=True)
                    continue

                if not isinstance(meta, dict):
                    meta_path.unlink(missing_ok=True)
                    continue

                user_id = meta.get("user_id")
                report_id = meta.get("report_id")
                if not isinstance(user_id, str) or not user_id or not isinstance(report_id, str) or not report_id:
                    meta_path.unlink(missing_ok=True)
                    continue

                if report_id in self._in_flight:
                    continue

                try:
                    due_at = float(meta.get("next_retry_at", 0.0))
                except (TypeError, ValueError):
                    due_at = 0.0

                if due_at > current_now:
                    remaining = max(0.0, due_at - current_now)
                    next_wait = remaining if next_wait is None else min(next_wait, remaining)
                    continue

                pdf_path = self._pdf_path(fallback_dir, report_id)
                if not pdf_path.exists():
                    logger.warning(
                        "Pending PDF upload metadata exists for report_id=%s without local PDF; dropping",
                        report_id,
                    )
                    meta_path.unlink(missing_ok=True)
                    continue

                try:
                    pdf_bytes = pdf_path.read_bytes()
                except OSError:
                    logger.exception("Failed reading pending PDF fallback for report_id=%s", report_id)
                    continue

                self._in_flight.add(report_id)

            bucket = self._bucket_getter()
            storage_path = self._storage_path_fn(user_id, report_id)
            attempt_num = int(meta.get("attempts", 0)) + 1

            try:
                client.storage.from_(bucket).upload(
                    storage_path,
                    pdf_bytes,
                    file_options={"content-type": "application/pdf", "upsert": "true"},
                )
            except Exception as exc:
                with self._lock:
                    self._in_flight.discard(report_id)
                    if report_id in self._cancelled or not meta_path.exists():
                        self._cancelled.discard(report_id)
                        continue
                    if not is_transient_storage_error(exc) or attempt_num >= self._max_attempts:
                        logger.error(
                            "Giving up background PDF upload retry for report_id=%s after %d attempts (%s: %s); keeping local fallback",
                            report_id,
                            attempt_num,
                            type(exc).__name__,
                            exc,
                        )
                        meta_path.unlink(missing_ok=True)
                        continue

                    base = min(self._max_backoff, self._initial_delay * (2 ** attempt_num))
                    delay = base + self._jitter(0.0, min(5.0, base * 0.2))
                    updated = {
                        **meta,
                        "attempts": attempt_num,
                        "next_retry_at": current_now + delay,
                        "last_error": f"{type(exc).__name__}: {exc}",
                    }
                    _atomic_write_json(meta_path, updated)
                    next_wait = delay if next_wait is None else min(next_wait, delay)
                    logger.warning(
                        "Background PDF upload retry %d/%d failed for report_id=%s (%s: %s); next retry in %.0fs",
                        attempt_num,
                        self._max_attempts,
                        report_id,
                        type(exc).__name__,
                        exc,
                        delay,
                    )
                continue

            with self._lock:
                self._in_flight.discard(report_id)
                was_cancelled = report_id in self._cancelled or not meta_path.exists()
                self._cancelled.discard(report_id)
                meta_path.unlink(missing_ok=True)
                pdf_path.unlink(missing_ok=True)

            if was_cancelled:
                try:
                    client.storage.from_(bucket).remove([storage_path])
                except Exception:
                    logger.warning(
                        "Cancelled pending PDF upload completed concurrently and could not be removed for report_id=%s",
                        report_id,
                        exc_info=True,
                    )
            else:
                logger.info(
                    "Background retry uploaded PDF to Supabase Storage for report_id=%s (bg attempt %d)",
                    report_id,
                    attempt_num,
                )

        return next_wait

    def start_worker(self) -> None:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop.clear()
            self._wake.clear()

            def loop() -> None:
                while not self._stop.is_set():
                    self._wake.clear()
                    try:
                        next_wait = self.process_due_once()
                    except Exception:
                        logger.exception("Pending PDF upload worker pass failed")
                        next_wait = 60.0
                    if self._stop.is_set():
                        break
                    self._wake.wait(timeout=next_wait)

            self._thread = threading.Thread(
                target=loop,
                name="pdf-upload-retry",
                daemon=True,
            )
            self._thread.start()

    def stop_worker(self, timeout: float = 2.0) -> None:
        self._stop.set()
        self._wake.set()
        with self._lock:
            thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=timeout)
