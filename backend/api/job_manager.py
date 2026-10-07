from __future__ import annotations

import threading
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

_JOBS: dict[str, dict[str, Any]] = {}
_LOCK = threading.Lock()

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
    return job_id


def update_job(job_id: str, *, status: str | None = None, progress: int | None = None,
               current_step: str | None = None, message: str | None = None,
               report_id: str | None = None, error: str | None = None) -> None:
    with _LOCK:
        job = _JOBS.get(job_id)
        if job is None:
            return
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


def get_job(job_id: str) -> dict[str, Any] | None:
    with _LOCK:
        job = _JOBS.get(job_id)
        return deepcopy(job) if job else None


def make_queue_callback(job_id: str):
    """For gpu_queue.gpu_slot: shows the job's place in line while it waits."""
    def callback(ahead: int) -> None:
        message = ("Waiting in queue: you're next" if ahead == 0
                   else f"Waiting in queue: {ahead} ahead of you")
        update_job(job_id, status="queued", current_step="queued", message=message)
    return callback


def make_progress_callback(job_id: str):
    def callback(progress: int, step: str, message: str) -> None:
        update_job(job_id, status="processing", progress=progress,
                   current_step=step, message=message)
    return callback
