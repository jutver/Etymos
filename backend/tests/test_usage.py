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
