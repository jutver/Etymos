"""
Keeps the GPU models under a VRAM budget, so the backend fits on a 12 GB card.

Each model module registers a loader here instead of keeping its own
singleton. A model is loaded on first use and stays loaded while it fits.
When a model that isn't loaded won't fit, the least recently used idle model
is unloaded to make room. On a 24 GB card nothing is ever unloaded; on 12 GB
the Vietnamese pair (~7.3 GB) and the English classifier take turns instead
of sitting side by side.

    with gpu_models.use("qwen_instruct") as (tokenizer, model):
        ...

- A model is "in use" between entering and leaving `use()`, and is never
  unloaded then. Several jobs can use the same model at once.
- A model used in the last GPU_EVICT_GRACE_SECONDS isn't unloaded either:
  the next paragraph of the same check will want it again, and reloading the
  Vietnamese pair takes far longer than waiting a few seconds.
- Don't call `use()` for a model that isn't loaded while already inside
  another `use()`: ask for every model a step needs in one call. Nesting is
  fine for models the outer call already holds.

Configuration (backend .env):
  GPU_MODEL_BUDGET_GB       VRAM the models may take together. Default: the
                            card's memory minus GPU_RESERVE_GB minus
                            GPU_JOB_HEADROOM_GB per GPU job slot.
  GPU_RESERVE_GB            default 0.8 (CUDA context, allocator slack)
  GPU_JOB_HEADROOM_GB       default 1.0 (activations of one running job)
  GPU_EVICT_GRACE_SECONDS   default 10
"""
from __future__ import annotations

import gc
import logging
import os
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")

GPU_RESERVE_GB = float(os.getenv("GPU_RESERVE_GB", "0.8"))
GPU_JOB_HEADROOM_GB = float(os.getenv("GPU_JOB_HEADROOM_GB", "1.0"))
GPU_EVICT_GRACE_SECONDS = float(os.getenv("GPU_EVICT_GRACE_SECONDS", "10"))
# How long a model that doesn't fit waits for others to go idle before it is
# loaded anyway (and risks running out of memory) instead of hanging the job.
WAIT_LIMIT_SECONDS = float(os.getenv("GPU_MODEL_WAIT_SECONDS", "300"))


@dataclass
class _Spec:
    loader: Callable[[], Any]
    estimate_gb: float


@dataclass
class _Entry:
    handle: Any
    size_gb: float
    refs: int = 0
    last_used: float = field(default_factory=time.monotonic)


_specs: dict[str, _Spec] = {}
_loaded: dict[str, _Entry] = {}
_loading: dict[str, float] = {}  # name -> estimate reserved while it loads
_cond = threading.Condition()
_budget_override: float | None = None
_budget_cache: float | None = None


def register(name: str, loader: Callable[[], Any], estimate_gb: float) -> None:
    """`loader()` returns the handle `use()` yields; raise to report failure."""
    _specs[name] = _Spec(loader, estimate_gb)


def total_vram_gb() -> float | None:
    """Memory of GPU 0 in GiB, or None without CUDA."""
    try:
        import torch

        if not torch.cuda.is_available():
            return None
        return torch.cuda.get_device_properties(0).total_memory / 1024**3
    except Exception:  # noqa: BLE001
        return None


def budget_gb() -> float:
    global _budget_cache
    if _budget_override is not None:
        return _budget_override
    if _budget_cache is None:
        configured = os.getenv("GPU_MODEL_BUDGET_GB")
        if configured:
            _budget_cache = float(configured)
        else:
            total = total_vram_gb()
            if total is None:
                _budget_cache = float("inf")
            else:
                from gpu_queue import GPU_JOB_SLOTS

                _budget_cache = max(1.0, total - GPU_RESERVE_GB - GPU_JOB_HEADROOM_GB * GPU_JOB_SLOTS)
                logger.info("GPU %.1f GB: models may use %.1f GB", total, _budget_cache)
    return _budget_cache


def set_budget_gb(value: float | None) -> None:
    """For tests: a fixed budget, or None to go back to the computed one."""
    global _budget_override
    _budget_override = value


def _used_gb() -> float:
    return sum(e.size_gb for e in _loaded.values()) + sum(_loading.values())


def _footprint_gb(handle: Any, estimate_gb: float) -> float:
    """CUDA memory held by the torch modules in `handle`; the estimate when there are none."""
    try:
        import torch
    except ImportError:
        return estimate_gb
    items = handle if isinstance(handle, (tuple, list)) else (handle,)
    total = 0
    seen: set[int] = set()
    for item in items:
        if not isinstance(item, torch.nn.Module):
            continue
        for tensor in list(item.parameters()) + list(item.buffers()):
            if tensor.is_cuda and id(tensor) not in seen:
                seen.add(id(tensor))
                total += tensor.numel() * tensor.element_size()
    return total / 1024**3 if total else estimate_gb


def _free_cuda_cache() -> None:
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass


def _evict(name: str) -> None:
    entry = _loaded.pop(name)
    logger.info("Unloading %s (%.1f GB) to make room", name, entry.size_gb)
    del entry
    _free_cuda_cache()


def _evictable(now: float, keep: set[str], *, ignore_grace: bool = False) -> list[str]:
    names = [
        n for n, e in _loaded.items()
        if e.refs == 0 and n not in keep and (ignore_grace or now - e.last_used >= GPU_EVICT_GRACE_SECONDS)
    ]
    return sorted(names, key=lambda n: _loaded[n].last_used)


def _reserve(names: tuple[str, ...]) -> list[str]:
    """Under _cond: wait until the missing models fit, then reserve them. Returns the names to load."""
    deadline = time.monotonic() + WAIT_LIMIT_SECONDS
    keep = set(names)
    while True:
        if any(n in _loading for n in names):
            _cond.wait(timeout=1.0)
            continue
        missing = [n for n in names if n not in _loaded]
        need = sum(_specs[n].estimate_gb for n in missing)
        budget = budget_gb()
        now = time.monotonic()
        if missing:
            for victim in _evictable(now, keep):
                if _used_gb() + need <= budget:
                    break
                _evict(victim)
        fits = _used_gb() + need <= budget
        busy = any(e.refs for n, e in _loaded.items() if n not in keep) or _loading
        if not fits and now >= deadline:
            logger.warning("Loading %s over the GPU budget after waiting %.0fs", missing, WAIT_LIMIT_SECONDS)
            for victim in _evictable(now, keep, ignore_grace=True):
                _evict(victim)
            fits = True
        if not fits and not busy and not _evictable(now, keep):
            # Nothing else is in use and everything idle is still in its grace
            # period: wait for it to expire. If nothing at all is left to
            # unload, this model alone is bigger than the budget: load anyway.
            if not any(n not in keep for n in _loaded):
                if missing:
                    logger.warning("%s needs %.1f GB, over the %.1f GB budget; loading anyway", missing, need, budget)
                fits = True
        if fits:
            for n in names:
                if n in _loaded:
                    _loaded[n].refs += 1
                    _loaded[n].last_used = now
            for n in missing:
                _loading[n] = _specs[n].estimate_gb
            return missing
        _cond.wait(timeout=1.0)


def _release(names: tuple[str, ...]) -> None:
    with _cond:
        now = time.monotonic()
        for n in names:
            entry = _loaded.get(n)
            if entry is not None:
                entry.refs = max(0, entry.refs - 1)
                entry.last_used = now
        _cond.notify_all()


@contextmanager
def use(*names: str) -> Iterator[Any]:
    """
    Yields the model's handle, or a tuple of handles for several names.
    Loader exceptions propagate unchanged, and the next call tries again.
    """
    for n in names:
        if n not in _specs:
            raise KeyError(f"Unknown GPU model {n!r}")

    with _cond:
        missing = _reserve(names)

    loaded_now: list[str] = []
    try:
        for n in missing:
            spec = _specs[n]
            logger.info("Loading %s...", n)
            started = time.monotonic()
            handle = spec.loader()
            size = _footprint_gb(handle, spec.estimate_gb)
            with _cond:
                _loading.pop(n, None)
                _loaded[n] = _Entry(handle=handle, size_gb=size, refs=1)
                _cond.notify_all()
            loaded_now.append(n)
            logger.info("Loaded %s: %.1f GB in %.0fs", n, size, time.monotonic() - started)
    except BaseException:
        with _cond:
            for n in missing:
                _loading.pop(n, None)
            _cond.notify_all()
        _release(tuple(n for n in names if n not in missing or n in loaded_now))
        raise

    try:
        handles = tuple(_loaded[n].handle for n in names)
        yield handles[0] if len(handles) == 1 else handles
    finally:
        _release(names)


def _is_oom(exc: BaseException) -> bool:
    try:
        import torch

        if isinstance(exc, torch.cuda.OutOfMemoryError):
            return True
    except Exception:  # noqa: BLE001
        pass
    return "out of memory" in str(exc).lower() and "cuda" in str(exc).lower()


def retry_on_oom(fn: Callable[[], T]) -> T:
    """Run `fn`; if CUDA runs out of memory, unload every idle model and try once more."""
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001
        if not _is_oom(exc):
            raise
        logger.warning("CUDA out of memory; unloading idle models and retrying once")
        free_idle()
        return fn()


def free_idle() -> list[str]:
    """Unload every model nobody is using right now. Returns their names."""
    with _cond:
        names = [n for n, e in _loaded.items() if e.refs == 0]
        for n in names:
            _evict(n)
        _cond.notify_all()
    if not names:
        _free_cuda_cache()
    return names


def status() -> list[dict]:
    with _cond:
        return [
            {"name": n, "size_gb": round(e.size_gb, 2), "in_use": e.refs}
            for n, e in sorted(_loaded.items())
        ]
