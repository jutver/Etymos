"""
Caps how many jobs use the GPU at once; the rest wait in arrival order.

Every check runs in its own thread (api/app.py), so without this a burst of
uploads would all hit the models together and could run the card out of
memory. A job holds a slot only while it runs its GPU pipeline; saving the
report and uploading files happen after the slot is released.

GPU_JOB_SLOTS (default 2) sets the number of slots.
"""
from __future__ import annotations

import os
import threading
from collections import deque
from contextlib import contextmanager
from typing import Callable, Iterator

GPU_JOB_SLOTS = max(1, int(os.getenv("GPU_JOB_SLOTS", "2")))

_cond = threading.Condition()
_waiting: deque[object] = deque()
_running = 0


@contextmanager
def gpu_slot(on_wait: Callable[[int], None] | None = None) -> Iterator[None]:
    """
    Blocks until a slot is free, first come first served. While waiting,
    on_wait(ahead) is called each time the number of jobs ahead in the queue
    changes (0 = next in line).
    """
    global _running
    ticket = object()
    with _cond:
        _waiting.append(ticket)
        last_ahead = None
        while _waiting[0] is not ticket or _running >= GPU_JOB_SLOTS:
            ahead = _waiting.index(ticket)
            if on_wait is not None and ahead != last_ahead:
                on_wait(ahead)
                last_ahead = ahead
            _cond.wait()
        _waiting.popleft()
        _running += 1
        # The head of the queue changed: let the others update their position.
        _cond.notify_all()
    try:
        yield
    finally:
        with _cond:
            _running -= 1
            _cond.notify_all()

