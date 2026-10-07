import threading
import time

import gpu_queue
from gpu_queue import gpu_slot


def _run_jobs(n, hold=0.2, stagger=0.01):
    state = {"active": 0, "peak": 0}
    started, waits = [], {}
    lock = threading.Lock()

    def job(i):
        with gpu_slot(on_wait=lambda ahead: waits.setdefault(i, []).append(ahead)):
            with lock:
                state["active"] += 1
                state["peak"] = max(state["peak"], state["active"])
                started.append(i)
            time.sleep(hold)
            with lock:
                state["active"] -= 1

    threads = []
    for i in range(n):
        t = threading.Thread(target=job, args=(i,))
        t.start()
        threads.append(t)
        time.sleep(stagger)  # fixes arrival order
    for t in threads:
        t.join(timeout=10)
    return state["peak"], started, waits


def test_at_most_slots_run_at_once_and_queue_is_fifo():
    assert gpu_queue.GPU_JOB_SLOTS == 2
    peak, started, waits = _run_jobs(6)
    assert peak == 2
    assert started == list(range(6))
    assert 0 not in waits and 1 not in waits  # first two never waited
    # Job 5 arrives with 3 already queued, then moves up to "next".
    assert waits[5][0] == 3
    assert waits[5][-1] == 0
    assert waits[5] == sorted(waits[5], reverse=True)


def test_slot_is_released_when_job_raises():
    try:
        with gpu_slot():
            raise RuntimeError("boom")
    except RuntimeError:
        pass
    peak, started, _ = _run_jobs(3, hold=0.02)
    assert peak == 2 and len(started) == 3
