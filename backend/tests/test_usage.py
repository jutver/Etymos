"""Plan quota in backend/api/usage.py: a paid plan whose term has ended is
treated as Free straight away (pg_cron writes the downgrade a little later)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

import usage


def _iso(delta: timedelta) -> str:
    return (datetime.now(timezone.utc) + delta).isoformat()


def _profile(**over) -> usage.ProfileUsage:
    base = dict(plan_tier="professional", standard_credits=0, premium_credits=0,
                checks_used_this_period=10, plan_period_start=_iso(-timedelta(days=3)),
                plan_expires_at=_iso(timedelta(days=20)))
    base.update(over)
    return usage.ProfileUsage(**base)


@pytest.fixture
def limits(monkeypatch):
    monkeypatch.setattr(usage, "_get_plan_doc_limit", lambda tier: {"free": 2, "professional": 50}[tier])


def test_active_plan_uses_its_own_limit(monkeypatch, limits):
    monkeypatch.setattr(usage, "_fetch_profile_usage", lambda uid: _profile())
    usage.ensure_quota_available("u", "plan")  # 10 of 50


def test_lapsed_plan_counts_as_free(monkeypatch, limits):
    p = _profile(plan_expires_at=_iso(-timedelta(minutes=1)))
    assert p.effective_plan_tier == "free"
    monkeypatch.setattr(usage, "_fetch_profile_usage", lambda uid: p)
    usage.ensure_quota_available("u", "plan")  # fresh Free count: 0 of 2


def test_lapsed_plan_free_limit_still_applies(monkeypatch):
    monkeypatch.setattr(usage, "_get_plan_doc_limit", lambda tier: {"free": 0, "professional": 50}[tier])
    monkeypatch.setattr(usage, "_fetch_profile_usage", lambda uid: _profile(plan_expires_at=_iso(-timedelta(days=1))))
    with pytest.raises(HTTPException) as err:
        usage.ensure_quota_available("u", "plan")
    assert err.value.status_code == 402


def test_no_end_date_never_lapses():
    assert _profile(plan_expires_at=None).effective_plan_tier == "professional"
    assert _profile(plan_tier="free", plan_expires_at=_iso(-timedelta(days=1))).effective_plan_tier == "free"


def test_postgrest_timestamp_formats():
    assert usage._has_lapsed("2020-01-01T00:00:00.12345+00:00") is True
    assert usage._has_lapsed("2999-01-01T00:00:00Z") is False
    assert usage._has_lapsed("garbage") is False


# --- unlocking a document with a credit ---------------------------------------


class _Rpc:
    def __init__(self, data=None, exc=None):
        self.data, self.exc, self.calls = data, exc, []

    def rpc(self, name, params):
        self.calls.append((name, params))
        return self

    def execute(self):
        if self.exc:
            raise self.exc
        return self


def test_credit_tier_maps_credit_balances_only():
    assert usage.credit_tier("standard") == "student"
    assert usage.credit_tier("premium") == "professional"
    assert usage.credit_tier("plan") is None


def test_unlock_returns_the_sql_result(monkeypatch):
    client = _Rpc({"status": "ok", "unlocked_tier": "student", "standard_credits": 1, "premium_credits": 0})
    monkeypatch.setattr(usage, "get_client", lambda: client)
    assert usage.unlock_document_with_credit("u", "d", "student")["unlocked_tier"] == "student"
    assert client.calls == [("unlock_document_with_credit", {"p_user_id": "u", "p_document_id": "d", "p_tier": "student"})]


@pytest.mark.parametrize(("data", "exc", "status"), [
    ({"status": "not_found"}, None, 404),
    ({"status": "no_credits"}, None, 402),
    ({"status": "weird"}, None, 500),
    (None, RuntimeError("down"), 500),
])
def test_unlock_failures_map_to_http_errors(monkeypatch, data, exc, status):
    monkeypatch.setattr(usage, "get_client", lambda: _Rpc(data, exc))
    with pytest.raises(HTTPException) as err:
        usage.unlock_document_with_credit("u", "d", "professional")
    assert err.value.status_code == status


def test_unlock_fails_closed_without_supabase(monkeypatch):
    monkeypatch.setattr(usage, "get_client", lambda: None)
    with pytest.raises(HTTPException) as err:
        usage.unlock_document_with_credit("u", "d", "student")
    assert err.value.status_code == 503
