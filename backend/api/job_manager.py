from __future__ import annotations

import asyncio
import logging
import threading
import time
import uuid
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from log_setup import bind_job, memory_summary, short_job

logger = logging.getLogger("jobs")

_JOBS: dict[str, dict[str, Any]] = {}
_LOCK = threading.Lock()
_SUBSCRIBERS: set["JobSubscriber"] = set()
_TERMINAL_STATUSES = ("completed", "failed")


@dataclass(eq=False)
class JobSubscriber:
    """Thread-safe SSE listener scoped to a user's active or specific job(s)."""

    loop: asyncio.AbstractEventLoop
    user_id: str
    job_ids: set[str] | None = None
    queue: asyncio.Queue[dict[str, Any]] = field(default_factory=lambda: asyncio.Queue(maxsize=128))

    def matches(self, job: dict[str, Any]) -> bool:
        if job.get("user_id") != self.user_id:
            return False
        if self.job_ids is not None and job.get("job_id") not in self.job_ids:
            return False
        return True

    def enqueue(self, snapshot: dict[str, Any]) -> None:
        if not self.queue.full():
            self.queue.put_nowait(snapshot)
            return
        # Never drop a terminal completion/failure update under progress-tick load.
        if snapshot.get("status") in _TERMINAL_STATUSES:
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                self.queue.put_nowait(snapshot)
            except asyncio.QueueFull:
                pass

# NOTE on durability: job records (queued/processing/failed) are
# intentionally in-memory only. Making in-flight job progress durable
# across a process restart would require a real task queue, which is
# explicitly out of scope here (this is a durability fix for *completed
# report* data, not an infra rewrite). If the process restarts mid-job,
# that job is lost the same way it was before this change; what's new is
# that a *completed* report's data (persisted via report_store.py into
# Supabase `documents`) survives the restart, and GET /api/reports/{id}
# can still serve it.


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_job(input_type: str, input_name: str | None = None,
               user_id: str | None = None) -> str:
    job_id = f"job_{uuid.uuid4().hex}"
    job = {
        "job_id": job_id,
        "input_type": input_type,
        "input_name": input_name,
        "user_id": user_id,
        "status": "queued",
        "progress": 0,
        "current_step": "queued",
        "message": "Job created",
        "report_id": None,
        "error": None,
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
    }
    with _LOCK:
        _JOBS[job_id] = job
        _TIMES[job_id] = (time.monotonic(), time.monotonic())
        active = _active_locked()
    logger.info("Job %s created: %s %r user=%s (active checks: %d)",
                short_job(job_id), input_type, input_name, (user_id or "-")[:8], active)
    return job_id


# job_id -> (created, last step change), monotonic seconds, for the durations
# in the log. Kept apart from the job dict, which is returned to clients.
_TIMES: dict[str, tuple[float, float]] = {}


def _active_locked() -> int:
    return sum(1 for job in _JOBS.values() if job["status"] in ("queued", "processing"))


def _log_transition(job_id: str, before: dict[str, Any], job: dict[str, Any], took: float, total: float) -> None:
    """One line per step change (not per progress tick), with how long the
    previous step took; a settled job gets its total time, memory and error."""
    j = short_job(job_id)
    if job["status"] == "completed":
        logger.info("Job %s completed in %.1fs: report=%s | %s", j, total, job["report_id"], memory_summary())
    elif job["status"] == "failed":
        logger.warning("Job %s FAILED in %.1fs at step %r (%s): %s | %s", j, total,
                       before["current_step"], job["message"], job["error"], memory_summary())
    elif job["current_step"] == "queued":
        logger.debug("Job %s queued: %s", j, job["message"])
    else:
        logger.info("Job %s step %s -> %s (%d%%, prev step %.1fs, total %.1fs): %s | %s", j,
                    before["current_step"], job["current_step"], job["progress"], took, total,
                    job["message"], memory_summary())


def update_job(job_id: str, *, status: str | None = None, progress: int | None = None,
               current_step: str | None = None, message: str | None = None,
               report_id: str | None = None, error: str | None = None) -> None:
    with _LOCK:
        job = _JOBS.get(job_id)
        if job is None:
            logger.warning("Update for unknown job %s (status=%s step=%s)", short_job(job_id), status, current_step)
            return
        before = {"status": job["status"], "current_step": job["current_step"]}
        if status is not None:
            job["status"] = status
        if progress is not None:
            job["progress"] = max(0, min(100, int(progress)))
        if current_step is not None:
            job["current_step"] = current_step
        if message is not None:
            job["message"] = message
        if report_id is not None:
            job["report_id"] = report_id
        if error is not None:
            job["error"] = error
        job["updated_at"] = _now_iso()
        changed = (job["status"], job["current_step"]) != (before["status"], before["current_step"])
        if changed:
            now = time.monotonic()
            created, last = _TIMES.get(job_id, (now, now))
            _TIMES[job_id] = (created, now)
            transition = (dict(before), dict(job), now - last, now - created)
        snapshot = deepcopy(job)
        subscribers = [sub for sub in _SUBSCRIBERS if sub.matches(snapshot)]
    if changed:
        _log_transition(job_id, *transition)
    for sub in subscribers:
        try:
            sub.loop.call_soon_threadsafe(sub.enqueue, deepcopy(snapshot))
        except RuntimeError:
            # Subscriber's event loop is already closed; unsubscribe lazily next pass.
            pass


def get_job(job_id: str) -> dict[str, Any] | None:
    with _LOCK:
        job = _JOBS.get(job_id)
        return deepcopy(job) if job else None


def subscribe_job(
    job_id: str,
    user_id: str,
    loop: asyncio.AbstractEventLoop,
) -> tuple[JobSubscriber | None, dict[str, Any] | None]:
    """Atomically registers a single-job subscriber and reads its current snapshot."""
    with _LOCK:
        job = _JOBS.get(job_id)
        if job is None:
            return None, None
        sub = JobSubscriber(loop=loop, user_id=user_id, job_ids={job_id})
        _SUBSCRIBERS.add(sub)
        return sub, deepcopy(job)


def subscribe_jobs(
    user_id: str,
    loop: asyncio.AbstractEventLoop,
    job_ids: list[str] | None = None,
) -> tuple[JobSubscriber, list[dict[str, Any]], list[str]]:
    """Atomically registers a multi-job subscriber scoped to `user_id`.
    Returns `(subscriber, owned_jobs, missing_or_foreign_job_ids)`."""
    filter_ids = set(job_ids) if job_ids is not None else None
    sub = JobSubscriber(loop=loop, user_id=user_id, job_ids=filter_ids)
    owned: list[dict[str, Any]] = []
    missing: list[str] = []
    with _LOCK:
        _SUBSCRIBERS.add(sub)
        if job_ids is not None:
            seen: set[str] = set()
            for jid in job_ids:
                if jid in seen:
                    continue
                seen.add(jid)
                job = _JOBS.get(jid)
                if job is not None and job.get("user_id") == user_id:
                    owned.append(deepcopy(job))
                else:
                    missing.append(jid)
        else:
            for job in _JOBS.values():
                if job.get("user_id") == user_id:
                    owned.append(deepcopy(job))
    return sub, owned, missing


def unsubscribe(sub: JobSubscriber | None) -> None:
    if sub is None:
        return
    with _LOCK:
        _SUBSCRIBERS.discard(sub)


def describe_active() -> list[str]:
    """The checks still queued or running, for the shutdown log."""
    now = time.monotonic()
    with _LOCK:
        return [
            f"{short_job(job_id)} {job['input_type']} {job['input_name']!r} at {job['current_step']} "
            f"({job['progress']}%, {now - _TIMES.get(job_id, (now, now))[0]:.0f}s old)"
            for job_id, job in _JOBS.items() if job["status"] in ("queued", "processing")
        ]


def make_queue_callback(job_id: str):
    """For gpu_queue.gpu_slot: shows the job's place in line while it waits."""
    def callback(ahead: int) -> None:
        message = ("Waiting in queue: you're next" if ahead == 0
                   else f"Waiting in queue: {ahead} ahead of you")
        update_job(job_id, status="queued", current_step="queued", message=message)
    return callback


def make_progress_callback(job_id: str):
    # Called on the check's own thread first thing in every run_*_job, so all
    # of the pipeline's log lines carry this job's id.
    bind_job(job_id)

    def callback(progress: int, step: str, message: str) -> None:
        update_job(job_id, status="processing", progress=progress,
                   current_step=step, message=message)
    return callback


def active_count() -> int:
    """Checks queued or running right now. The auto-deploy waits for 0 before restarting."""
    with _LOCK:
        return _active_locked()


def job_overview(recent: int = 20) -> dict[str, Any]:
    """For the admin Server screen: the checks in progress, and the newest
    ones that ended since the API started (jobs live in memory only)."""
    now = time.monotonic()

    def row(job_id: str, job: dict[str, Any]) -> dict[str, Any]:
        created, last = _TIMES.get(job_id, (now, now))
        return {
            "job_id": job_id,
            "input_type": job["input_type"],
            "input_name": job["input_name"],
            "user_id": job["user_id"],
            "status": job["status"],
            "progress": job["progress"],
            "current_step": job["current_step"],
            "message": job["message"],
            "report_id": job["report_id"],
            "error": job["error"],
            "created_at": job["created_at"],
            "updated_at": job["updated_at"],
            "age_seconds": round(now - created, 1),
            "step_seconds": round(now - last, 1),
        }

    with _LOCK:
        rows = [row(job_id, job) for job_id, job in _JOBS.items()]
    active = [r for r in rows if r["status"] in ("queued", "processing")]
    ended = [r for r in rows if r["status"] not in ("queued", "processing")]
    ended.sort(key=lambda r: r["updated_at"], reverse=True)
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    return {"active": active, "recent": ended[:recent], "counts": counts}
