"""Save & re-check pricing in backend/api/recheck_quota.py: the change ratio,
per-tier free limits, the baseline/free-count history, and the quote endpoint."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

import recheck_quota as rq
import usage


def words(n: int, prefix: str = "w") -> str:
    return " ".join(f"{prefix}{i}" for i in range(n))


# --- changed_ratio ------------------------------------------------------------

def test_unchanged_text_is_zero():
    text = words(50) + "\n\n" + words(50, "x")
    assert rq.changed_ratio(text, text) == 0.0


def test_case_punctuation_and_paragraph_spacing_are_not_changes():
    assert rq.changed_ratio("Hello, world.\n\nSecond line here", "hello world\nSecond line here!") == 0.0


def test_replaced_words_count():
    base = words(100)
    edited = base.replace("w10 w11 w12", "new1 new2 new3")
    assert rq.changed_ratio(base, edited) == pytest.approx(0.03)


def test_added_words_count():
    base = words(100)
    assert rq.changed_ratio(base, base + "\n\n" + words(20, "add")) == pytest.approx(0.20)


def test_pure_deletions_are_free():
    base = words(100) + "\n\n" + words(100, "copied")
    assert rq.changed_ratio(base, words(100)) == 0.0


def test_replacing_the_whole_document_counts_fully():
    assert rq.changed_ratio(words(100), words(100, "other")) == 1.0
    assert rq.changed_ratio(words(100), words(300, "other")) == 1.0  # capped


def test_edit_inside_one_paragraph_of_many():
    paras = [words(20, f"p{i}_") for i in range(10)]
    edited = list(paras)
    edited[4] = edited[4].replace("p4_3", "changed")
    assert rq.changed_ratio("\n\n".join(paras), "\n\n".join(edited)) == pytest.approx(1 / 200)


def test_empty_baseline():
    assert rq.changed_ratio("", "") == 0.0
    assert rq.changed_ratio("", "new text") == 1.0


def test_vietnamese_words_are_tokenized():
    base = "Nghiên cứu này phân tích dữ liệu"
    assert rq.changed_ratio(base, base) == 0.0
    assert rq.changed_ratio(base, "Nghiên cứu này đánh giá dữ liệu") == pytest.approx(2 / 7)


# --- tiers and limits -----------------------------------------------------------

@pytest.mark.parametrize("plan, unlocked, expected", [
    ("free", None, "free"),
    ("free", "professional", "professional"),
    ("student", None, "student"),
    ("professional", "student", "professional"),
    ("student", "professional", "professional"),
    (None, "garbage", "free"),
])
def test_effective_tier_is_the_higher_one(plan, unlocked, expected):
    assert rq.effective_tier(plan, unlocked) == expected


@pytest.mark.parametrize("tier, free_rechecks, change_limit", [
    ("free", 3, 0.30),
    ("student", 6, 0.50),
    ("professional", 10, 0.65),
])
def test_tier_limits_and_boundaries(tier, free_rechecks, change_limit):
    limits = rq.DEFAULT_LIMITS[tier]
    assert (limits.free_rechecks, limits.change_limit) == (free_rechecks, change_limit)
    assert rq.decide_cost(change_limit - 0.0001, free_rechecks - 1, limits) == "free"
    assert rq.decide_cost(change_limit, 0, limits) == "check"  # "less than" the limit
    assert rq.decide_cost(0.0, free_rechecks, limits) == "check"  # all free re-checks used


def test_limits_fall_back_to_defaults_without_supabase(monkeypatch):
    monkeypatch.setattr(rq, "get_client", lambda: None)
    rq._limits_cache.clear()
    assert rq.get_recheck_limits("student") == rq.DEFAULT_LIMITS["student"]
    assert rq.get_recheck_limits("unknown") == rq.DEFAULT_LIMITS["free"]


# --- history --------------------------------------------------------------------

class FakeQuery:
    def __init__(self, rows, fail=False):
        self.rows, self.fail = rows, fail

    def __getattr__(self, _name):
        return lambda *a, **k: self

    def execute(self):
        if self.fail:
            raise RuntimeError("down")
        return SimpleNamespace(data=self.rows)


def fake_client(tables: dict, fail: bool = False):
    return SimpleNamespace(table=lambda name: FakeQuery(tables.get(name, []), fail))


def test_free_count_resets_after_a_paid_recheck(monkeypatch):
    rows = [  # newest first
        {"kind": "free_recheck", "baseline_text": "c"},
        {"kind": "free_recheck", "baseline_text": "b"},
        {"kind": "paid_recheck", "baseline_text": "paid text"},
        {"kind": "free_recheck", "baseline_text": "a"},
    ]
    monkeypatch.setattr(rq, "get_client", lambda: fake_client({"document_checks": rows}))
    assert rq.load_check_history("d") == rq.CheckHistory(paid_baseline="paid text", free_used=2)


def test_without_a_paid_recheck_the_baseline_is_the_upload(monkeypatch):
    # The stored passages now hold the re-checked text; the upload's text is
    # the oldest re-check's previous_text. Otherwise free re-checks would
    # reset the cumulative change limit.
    rows = [  # newest first
        {"kind": "free_recheck", "baseline_text": "second edit", "previous_text": "first edit"},
        {"kind": "free_recheck", "baseline_text": "first edit", "previous_text": "the upload"},
    ]
    monkeypatch.setattr(rq, "get_client", lambda: fake_client({"document_checks": rows}))
    assert rq.load_check_history("d") == rq.CheckHistory(paid_baseline="the upload", free_used=2)


def test_no_history_means_the_passages_are_the_upload(monkeypatch):
    monkeypatch.setattr(rq, "get_client", lambda: fake_client({"document_checks": []}))
    assert rq.load_check_history("d") == rq.CheckHistory(paid_baseline=None, free_used=0)


def test_history_failure_fails_closed(monkeypatch):
    from fastapi import HTTPException

    monkeypatch.setattr(rq, "get_client", lambda: fake_client({}, fail=True))
    with pytest.raises(HTTPException) as err:
        rq.load_check_history("d")
    assert err.value.status_code == 503


def test_original_text_prefers_passages(monkeypatch):
    passages = [{"text": "First para"}, {"text": ""}, {"text": "Second para"}]
    monkeypatch.setattr(rq, "get_client", lambda: fake_client({"document_passages": passages}))
    assert rq.original_text("d", {"input_text": "ignored"}) == "First para\n\nSecond para"
    monkeypatch.setattr(rq, "get_client", lambda: None)
    assert rq.original_text("d", {"input_text": "raw text"}) == "raw text"


# --- quote ----------------------------------------------------------------------

def profile(tier: str) -> usage.ProfileUsage:
    return usage.ProfileUsage(plan_tier=tier, standard_credits=0, premium_credits=0,
                              checks_used_this_period=0, plan_period_start=None)


@pytest.fixture
def quote_env(monkeypatch):
    """Upload text of 100 words, no Supabase, default limits."""
    state = {"history": rq.CheckHistory(paid_baseline=None, free_used=0), "plan": "free"}
    monkeypatch.setattr(rq, "load_check_history", lambda doc: state["history"])
    monkeypatch.setattr(rq, "_fetch_profile_usage", lambda uid: profile(state["plan"]))
    monkeypatch.setattr(rq, "get_client", lambda: None)
    rq._limits_cache.clear()
    return state


def test_quote_small_edit_on_free_is_free(quote_env):
    report = {"user_id": "u", "input_text": words(100)}
    q = rq.quote_recheck("d", report, words(100).replace("w1 ", "x1 "))
    assert q == {"tier": "free", "changed_ratio": 0.01, "change_limit": 0.30, "free_used": 0,
                 "free_limit": 3, "free_left": 3, "cost": "free"}


def test_quote_change_limit_is_cumulative_against_the_baseline(quote_env):
    # Third re-check of the same upload: 35% changed overall costs a check on
    # Free even though each step was small.
    quote_env["history"] = rq.CheckHistory(paid_baseline=None, free_used=2)
    edited = words(100).replace(" ".join(f"w{i}" for i in range(35)), words(35, "n"))
    q = rq.quote_recheck("d", {"user_id": "u", "input_text": words(100)}, edited)
    assert (q["changed_ratio"], q["free_left"], q["cost"]) == (0.35, 1, "check")


def test_quote_uses_the_paid_baseline(quote_env):
    quote_env["history"] = rq.CheckHistory(paid_baseline=words(100, "p"), free_used=0)
    q = rq.quote_recheck("d", {"user_id": "u", "input_text": words(100)}, words(100, "p"))
    assert (q["changed_ratio"], q["cost"]) == (0.0, "free")


def test_quote_document_tier_raises_the_limits(quote_env):
    # A Free user whose document was unlocked with a Premium credit.
    edited = words(100).replace(" ".join(f"w{i}" for i in range(40)), words(40, "n"))
    report = {"user_id": "u", "input_text": words(100), "unlocked_tier": "professional"}
    q = rq.quote_recheck("d", report, edited)
    assert (q["tier"], q["free_limit"], q["cost"]) == ("professional", 10, "free")


def test_quote_plan_upgrade_applies_without_reset(quote_env):
    quote_env["history"] = rq.CheckHistory(paid_baseline=None, free_used=3)
    report = {"user_id": "u", "input_text": words(100)}
    assert rq.quote_recheck("d", report, words(100))["cost"] == "check"
    quote_env["plan"] = "student"
    q = rq.quote_recheck("d", report, words(100))
    assert (q["free_used"], q["free_left"], q["cost"]) == (3, 3, "free")


# --- POST /api/reports/{id}/recheck/quote -----------------------------------------

@pytest.fixture
def api_client(monkeypatch):
    from fastapi.testclient import TestClient

    import app as api_app
    from auth import AuthedUser, verify_supabase_jwt

    api_app.app.dependency_overrides[verify_supabase_jwt] = lambda: AuthedUser(user_id="user-1", email=None, role="user", is_admin=False)
    api_app.limiter.enabled = False
    yield api_app, TestClient(api_app.app)
    api_app.app.dependency_overrides.clear()
    api_app.limiter.enabled = True


def test_endpoint_returns_the_quote(api_client, monkeypatch, quote_env):
    api_app, client = api_client
    monkeypatch.setattr(api_app, "get_report", lambda rid: {"user_id": "user-1", "input_text": "One two three"})
    res = client.post("/api/reports/r-1/recheck/quote",
                      json={"blocks": [{"block_id": "a", "text": "One two"}, {"block_id": "b", "text": "three"}]})
    assert res.status_code == 200
    assert res.json()["cost"] == "free"
    assert res.json()["changed_ratio"] == 0.0


def test_endpoint_hides_someone_elses_report(api_client, monkeypatch):
    api_app, client = api_client
    monkeypatch.setattr(api_app, "get_report", lambda rid: {"user_id": "someone-else"})
    res = client.post("/api/reports/r-2/recheck/quote", json={"blocks": [{"block_id": "a", "text": "x"}]})
    assert res.status_code == 404


def test_endpoint_rejects_oversized_text(api_client, monkeypatch):
    api_app, client = api_client
    monkeypatch.setattr(api_app, "get_report", lambda rid: {"user_id": "user-1"})
    blocks = [{"block_id": str(i), "text": "x" * 60_000} for i in range(2)]
    assert client.post("/api/reports/r-3/recheck/quote", json={"blocks": blocks}).status_code == 413
    assert client.post("/api/reports/r-3/recheck/quote", json={"blocks": []}).status_code == 422


def test_the_stored_upload_result_is_not_a_recheck(monkeypatch):
    rows = [  # newest first
        {"kind": "free_recheck", "baseline_text": "first edit", "previous_text": "the upload"},
        {"kind": "upload", "baseline_text": "the upload", "previous_text": None},
    ]
    monkeypatch.setattr(rq, "get_client", lambda: fake_client({"document_checks": rows}))
    assert rq.load_check_history("d") == rq.CheckHistory(paid_baseline="the upload", free_used=1)
    monkeypatch.setattr(rq, "get_client", lambda: fake_client({"document_checks": rows[1:]}))
    assert rq.load_check_history("d") == rq.CheckHistory(paid_baseline=None, free_used=0)
