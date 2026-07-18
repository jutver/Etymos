"""
Tests for backend/api/auth.py: the verify_supabase_jwt dependency and the
require_owner_or_admin ownership guard.

These wire auth.py's real verify_supabase_jwt + require_owner_or_admin into
a small standalone FastAPI app that mirrors the exact pattern
backend/api/app.py uses for GET/DELETE /api/reports/{id} and
GET /api/jobs/{id} (fetch resource -> 404 if missing -> ownership check).
We deliberately don't import the real backend/api/app.py here: it pulls in
the full plagiarism pipeline (PyMuPDF, sentence_transformers, the paper
search modules, etc.), none of which auth.py's behavior depends on. The
Supabase client is mocked throughout via monkeypatching auth.get_client —
no live project is ever contacted.
"""
from __future__ import annotations

import time

import jwt
import pytest
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient

import auth
from auth import AuthedUser, require_owner_or_admin, verify_supabase_jwt

JWT_SECRET = "test-secret-key-at-least-32-bytes-long-for-hs256"


def _make_token(*, sub: str = "user-1", exp_delta: int = 3600,
                 aud: str = "authenticated", secret: str = JWT_SECRET,
                 **extra_claims) -> str:
    payload = {
        "sub": sub,
        "aud": aud,
        "exp": int(time.time()) + exp_delta,
        **extra_claims,
    }
    return jwt.encode(payload, secret, algorithm="HS256")


@pytest.fixture(autouse=True)
def _configure_jwt_secret(monkeypatch):
    monkeypatch.setattr(auth, "SUPABASE_JWT_SECRET", JWT_SECRET)
    monkeypatch.setattr(auth, "JWT_AUDIENCE", "authenticated")


@pytest.fixture(autouse=True)
def _no_supabase_client_by_default(monkeypatch):
    """No Supabase client configured by default (role lookups fall back to
    "user"). Individual tests override via mock_profile_role(). Either way,
    no network call ever happens."""
    monkeypatch.setattr(auth, "get_client", lambda: None)


def mock_profile_role(monkeypatch, role: str):
    """Simulate a configured Supabase client whose `profiles` table lookup
    returns the given role, without touching the network."""

    class _FakeResponse:
        def __init__(self, data):
            self.data = data

    class _FakeQuery:
        def __init__(self, data):
            self._data = data

        def select(self, *_args, **_kwargs):
            return self

        def eq(self, *_args, **_kwargs):
            return self

        def single(self):
            return self

        def execute(self):
            return _FakeResponse(self._data)

    class _FakeClient:
        def table(self, name):
            assert name == "profiles"
            return _FakeQuery({"role": role})

    monkeypatch.setattr(auth, "get_client", lambda: _FakeClient())


# ---------------------------------------------------------------------------
# Minimal app exercising the exact ownership-check pattern app.py uses for
# GET/DELETE /api/reports/{id} and GET /api/jobs/{id}.
# ---------------------------------------------------------------------------

_FAKE_REPORTS = {"report-1": {"user_id": "user-1"}}
_FAKE_JOBS = {"job-1": {"user_id": "user-1"}}


def _build_test_app() -> FastAPI:
    app = FastAPI()

    @app.get("/api/health")
    def health():
        # Mirrors app.py: the one route with no auth dependency at all.
        return {"status": "ok"}

    @app.get("/api/reports/{report_id}")
    def read_report(report_id: str, user: AuthedUser = Depends(verify_supabase_jwt)):
        report = _FAKE_REPORTS.get(report_id)
        if report is None:
            raise HTTPException(status_code=404, detail="Report not found.")
        require_owner_or_admin(report.get("user_id"), user)
        return report

    @app.delete("/api/reports/{report_id}")
    def delete_report_route(report_id: str, user: AuthedUser = Depends(verify_supabase_jwt)):
        report = _FAKE_REPORTS.get(report_id)
        if report is None:
            raise HTTPException(status_code=404, detail="Report not found.")
        require_owner_or_admin(report.get("user_id"), user)
        return {"deleted": True}

    @app.get("/api/jobs/{job_id}")
    def read_job_route(job_id: str, user: AuthedUser = Depends(verify_supabase_jwt)):
        job = _FAKE_JOBS.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found.")
        require_owner_or_admin(job.get("user_id"), user)
        return job

    return app


@pytest.fixture
def client():
    return TestClient(_build_test_app())


# ---------------------------------------------------------------------------
# verify_supabase_jwt: missing / invalid / expired / valid tokens
# ---------------------------------------------------------------------------

def test_missing_token_returns_401(client):
    resp = client.get("/api/reports/report-1")
    assert resp.status_code == 401


def test_invalid_token_returns_401(client):
    resp = client.get(
        "/api/reports/report-1",
        headers={"Authorization": "Bearer not-a-real-token"},
    )
    assert resp.status_code == 401


def test_expired_token_returns_401(client):
    token = _make_token(exp_delta=-3600)
    resp = client.get(
        "/api/reports/report-1",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 401


def test_wrong_signature_returns_401(client):
    token = _make_token(secret="wrong-secret")
    resp = client.get(
        "/api/reports/report-1",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 401


def test_wrong_audience_returns_401(client):
    token = _make_token(aud="some-other-audience")
    resp = client.get(
        "/api/reports/report-1",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 401


def test_valid_token_proceeds(client, monkeypatch):
    mock_profile_role(monkeypatch, "user")
    token = _make_token(sub="user-1")
    resp = client.get(
        "/api/reports/report-1",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.json()["user_id"] == "user-1"


def test_missing_supabase_jwt_secret_returns_500(client, monkeypatch):
    # Server misconfiguration (no SUPABASE_JWT_SECRET) must fail loudly,
    # never silently accept an unverifiable token.
    monkeypatch.setattr(auth, "SUPABASE_JWT_SECRET", None)
    token = _make_token()
    resp = client.get(
        "/api/reports/report-1",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 500


def test_health_route_needs_no_auth():
    resp = TestClient(_build_test_app()).get("/api/health")
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# require_owner_or_admin: ownership checks on /api/reports/{id} (GET/DELETE)
# and /api/jobs/{id} (GET)
# ---------------------------------------------------------------------------

def test_owner_can_read_own_report(client, monkeypatch):
    mock_profile_role(monkeypatch, "user")
    token = _make_token(sub="user-1")
    resp = client.get("/api/reports/report-1", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200


def test_wrong_owner_read_report_returns_404(client, monkeypatch):
    mock_profile_role(monkeypatch, "user")
    token = _make_token(sub="someone-else")
    resp = client.get("/api/reports/report-1", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 404


def test_wrong_owner_delete_report_returns_404(client, monkeypatch):
    mock_profile_role(monkeypatch, "user")
    token = _make_token(sub="someone-else")
    resp = client.delete("/api/reports/report-1", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 404


def test_wrong_owner_read_job_returns_404(client, monkeypatch):
    mock_profile_role(monkeypatch, "user")
    token = _make_token(sub="someone-else")
    resp = client.get("/api/jobs/job-1", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 404


def test_owner_can_read_own_job(client, monkeypatch):
    mock_profile_role(monkeypatch, "user")
    token = _make_token(sub="user-1")
    resp = client.get("/api/jobs/job-1", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200


def test_admin_can_read_any_report(client, monkeypatch):
    mock_profile_role(monkeypatch, "admin")
    token = _make_token(sub="admin-user")
    resp = client.get("/api/reports/report-1", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200


def test_admin_can_delete_any_report(client, monkeypatch):
    mock_profile_role(monkeypatch, "admin")
    token = _make_token(sub="admin-user")
    resp = client.delete("/api/reports/report-1", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200


def test_admin_can_read_any_job(client, monkeypatch):
    mock_profile_role(monkeypatch, "admin")
    token = _make_token(sub="admin-user")
    resp = client.get("/api/jobs/job-1", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200


def test_nonexistent_report_returns_404(client, monkeypatch):
    mock_profile_role(monkeypatch, "user")
    token = _make_token(sub="user-1")
    resp = client.get("/api/reports/does-not-exist", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 404


def test_nonexistent_job_returns_404(client, monkeypatch):
    mock_profile_role(monkeypatch, "user")
    token = _make_token(sub="user-1")
    resp = client.get("/api/jobs/does-not-exist", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# _fetch_profile_role: graceful fallback when Supabase is unreachable/unset
# ---------------------------------------------------------------------------

def test_role_lookup_failure_falls_back_to_user_not_admin(monkeypatch):
    class _BoomClient:
        def table(self, name):
            raise RuntimeError("simulated Supabase outage")

    monkeypatch.setattr(auth, "get_client", lambda: _BoomClient())
    assert auth._fetch_profile_role("user-1") == "user"


def test_no_supabase_configured_defaults_to_user(monkeypatch):
    monkeypatch.setattr(auth, "get_client", lambda: None)
    assert auth._fetch_profile_role("user-1") == "user"
