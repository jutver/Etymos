import threading
import time

import pytest

import gpu_models


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    monkeypatch.setattr(gpu_models, "_specs", {})
    monkeypatch.setattr(gpu_models, "_loaded", {})
    monkeypatch.setattr(gpu_models, "_loading", {})
    monkeypatch.setattr(gpu_models, "GPU_EVICT_GRACE_SECONDS", 0.0)
    monkeypatch.setattr(gpu_models, "WAIT_LIMIT_SECONDS", 5.0)
    # No torch modules in the handles: sizes come from the estimates.
    monkeypatch.setattr(gpu_models, "_footprint_gb", lambda handle, estimate: estimate)
    monkeypatch.setattr(gpu_models, "_free_cuda_cache", lambda: None)
    gpu_models.set_budget_gb(9.0)
    yield
    gpu_models.set_budget_gb(None)


def register(name, size, loads):
    def loader():
        loads.append(name)
        return f"{name}-handle"

    gpu_models.register(name, loader, estimate_gb=size)


def loaded():
    return sorted(gpu_models._loaded)


def test_loads_once_and_keeps_models_that_fit():
    loads = []
    register("viet", 7.1, loads)
    register("qwen", 1.3, loads)

    for _ in range(3):
        with gpu_models.use("viet") as handle:
            assert handle == "viet-handle"
        with gpu_models.use("qwen"):
            pass

    assert loads == ["viet", "qwen"]
    assert loaded() == ["qwen", "viet"]


def test_unloads_least_recently_used_idle_model_to_make_room():
    gpu_models.set_budget_gb(9.5)
    loads = []
    register("viet", 7.1, loads)
    register("qwen", 1.3, loads)
    register("clf", 0.7, loads)
    register("e5", 0.5, loads)

    with gpu_models.use("e5"):
        pass
    with gpu_models.use("viet"):
        pass
    with gpu_models.use("qwen"):
        pass
    # 0.5 + 7.1 + 1.3 = 8.9; the classifier's 0.7 doesn't fit in 9.5, so the oldest (e5) goes.
    with gpu_models.use("clf"):
        pass

    assert loaded() == ["clf", "qwen", "viet"]
    with gpu_models.use("e5"):
        pass
    assert loads.count("e5") == 2


def test_never_unloads_a_model_in_use():
    loads = []
    register("viet", 7.1, loads)
    register("big", 3.0, loads)
    order = []

    release = threading.Event()

    def holder():
        with gpu_models.use("viet"):
            order.append("holding")
            release.wait(5)
        order.append("released")

    t = threading.Thread(target=holder)
    t.start()
    while "holding" not in order:
        time.sleep(0.01)

    def other():
        with gpu_models.use("big"):
            order.append("big loaded")

    t2 = threading.Thread(target=other)
    t2.start()
    time.sleep(0.3)
    assert "big loaded" not in order  # waits: 7.1 + 3.0 is over budget and viet is busy
    release.set()
    t.join()
    t2.join()

    assert order == ["holding", "released", "big loaded"]
    assert loaded() == ["big"]


def test_model_bigger_than_budget_still_loads_alone():
    loads = []
    register("huge", 20.0, loads)
    with gpu_models.use("huge") as handle:
        assert handle == "huge-handle"


def test_several_models_at_once_are_yielded_in_order():
    loads = []
    register("a", 1.0, loads)
    register("b", 1.0, loads)
    with gpu_models.use("b", "a") as (b, a):
        assert (a, b) == ("a-handle", "b-handle")


def test_nested_use_of_a_held_model_does_not_wait():
    loads = []
    register("viet", 7.1, loads)
    with gpu_models.use("viet"):
        with gpu_models.use("viet") as handle:
            assert handle == "viet-handle"
        assert gpu_models._loaded["viet"].refs == 1
    assert gpu_models._loaded["viet"].refs == 0


def test_failed_load_is_retried_next_time_and_frees_its_reservation():
    calls = []

    def loader():
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("no weights")
        return "ok"

    gpu_models.register("flaky", loader, estimate_gb=1.0)
    with pytest.raises(RuntimeError):
        with gpu_models.use("flaky"):
            pass
    assert gpu_models._loading == {}
    with gpu_models.use("flaky") as handle:
        assert handle == "ok"


def test_recently_used_models_get_a_grace_period(monkeypatch):
    monkeypatch.setattr(gpu_models, "GPU_EVICT_GRACE_SECONDS", 0.3)
    loads = []
    register("viet", 7.1, loads)
    register("big", 3.0, loads)
    with gpu_models.use("viet"):
        pass

    started = time.monotonic()
    with gpu_models.use("big"):
        pass
    assert time.monotonic() - started >= 0.25
    assert loaded() == ["big"]


def test_retry_on_oom_frees_idle_models_and_retries_once():
    loads = []
    register("idle", 1.0, loads)
    with gpu_models.use("idle"):
        pass

    attempts = []

    def fn():
        attempts.append(1)
        if len(attempts) == 1:
            raise RuntimeError("CUDA out of memory. Tried to allocate 20.00 MiB")
        return "done"

    assert gpu_models.retry_on_oom(fn) == "done"
    assert loaded() == []


def test_retry_on_oom_leaves_other_errors_alone():
    with pytest.raises(ValueError):
        gpu_models.retry_on_oom(lambda: (_ for _ in ()).throw(ValueError("bad")))


def test_unknown_model_is_an_error():
    with pytest.raises(KeyError):
        with gpu_models.use("nope"):
            pass
