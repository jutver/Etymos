"""
Tests for backend/api/recovery_email.py: setting, verifying and using a
recovery address. Supabase and SMTP are replaced by in-memory fakes — no
live project or mailbox is contacted. Like test_auth.py, the router is
mounted on a small standalone app rather than importing app.py and its
whole ML pipeline.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from slowapi.middleware import SlowAPIMiddleware
from starlette.requests import Request

import mailer
import rate_limit
import recovery_email
from auth import AuthedUser, verify_supabase_jwt


# --- in-memory stand-in for the supabase-py query builder -----------------


class _Query:
    def __init__(self, db: "FakeDB", table: str):
        self.db, self.table = db, table
        self.filters: list = []
        self.op = "select"
        self.payload = None
        self.on_conflict = None
        self.negate = False

    def select(self, *_):
        return self

    def limit(self, *_):
        return self

    def eq(self, col, val):
        self.filters.append(lambda r, c=col, v=val: r.get(c) == v)
        return self

    def neq(self, col, val):
        self.filters.append(lambda r, c=col, v=val: r.get(c) != v)
        return self

    @property
    def not_(self):
        self.negate = True
        return self

    def is_(self, col, val):
        assert val == "null"
        neg = self.negate
        self.negate = False
        self.filters.append(lambda r, c=col: (r.get(c) is not None) if neg else (r.get(c) is None))
        return self

    def upsert(self, payload, on_conflict=None):
        self.op, self.payload, self.on_conflict = "upsert", payload, on_conflict
        return self

    def update(self, payload):
        self.op, self.payload = "update", payload
        return self

    def delete(self):
        self.op = "delete"
        return self

    def execute(self):
        rows = self.db.tables.setdefault(self.table, [])
        match = [r for r in rows if all(f(r) for f in self.filters)]
        if self.op == "select":
            return SimpleNamespace(data=[dict(r) for r in match])
        if self.op == "upsert":
            key = self.on_conflict
            for r in rows:
                if r[key] == self.payload[key]:
                    r.update(self.payload)
                    return SimpleNamespace(data=[dict(r)])
            rows.append(dict(self.payload))
            return SimpleNamespace(data=[dict(self.payload)])
        if self.op == "update":
            for r in match:
                r.update(self.payload)
            return SimpleNamespace(data=match)
        if self.op == "delete":
            self.db.tables[self.table] = [r for r in rows if r not in match]
            return SimpleNamespace(data=match)
        raise AssertionError(self.op)


class FakeDB:
    def __init__(self):
        self.tables: dict = {}
        self.generated: list = []
        users = {"user-1": "owner@example.com", "user-2": "other@example.com"}
        db = self

        class _Admin:
            def get_user_by_id(self, uid):
                return SimpleNamespace(user=SimpleNamespace(email=users[uid]))

            def generate_link(self, params):
                db.generated.append(params)
                return SimpleNamespace(properties=SimpleNamespace(action_link="https://supabase.test/verify?token=abc"))

        self.auth = SimpleNamespace(admin=_Admin())

    def table(self, name):
        return _Query(self, name)


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()
    sent: list = []
    monkeypatch.setattr(recovery_email, "get_client", lambda: db)
    monkeypatch.setattr(mailer, "is_configured", lambda: True)
    monkeypatch.setattr(mailer, "send_email", lambda to, content, lang: sent.append((to, content, lang)))

    current = {"user": AuthedUser(user_id="user-1", email="owner@example.com", role="user", is_admin=False)}
    app = FastAPI()
    app.state.limiter = rate_limit.limiter
    app.add_middleware(SlowAPIMiddleware)
    app.include_router(recovery_email.router)
    app.dependency_overrides[verify_supabase_jwt] = lambda: current["user"]
    rate_limit.limiter.reset()
    return SimpleNamespace(client=TestClient(app), db=db, sent=sent, current=current)


def _token_from(sent_item) -> str:
    return re.search(r"#token=([\w-]+)", sent_item[1].button_url).group(1)


# --- helpers ---------------------------------------------------------------


def test_normalize_email():
    assert recovery_email.normalize_email("  Me@Example.COM ") == "me@example.com"
    assert recovery_email.normalize_email("not-an-email") is None


def test_parse_ts_handles_postgrest_formats():
    a = recovery_email._parse_ts("2026-10-02T07:00:00.12345+00:00")
    b = recovery_email._parse_ts("2026-10-02T07:00:00Z")
    assert a.tzinfo is not None and b == datetime(2026, 10, 2, 7, tzinfo=timezone.utc)


def _request(peer: str, cf: str | None) -> Request:
    headers = [(b"cf-connecting-ip", cf.encode())] if cf else []
    return Request({"type": "http", "client": (peer, 1234), "headers": headers})


def test_client_ip_trusts_cloudflare_header_only_from_loopback():
    assert rate_limit.client_ip(_request("127.0.0.1", "203.0.113.9")) == "203.0.113.9"
    assert rate_limit.client_ip(_request("198.51.100.4", "203.0.113.9")) == "198.51.100.4"


# --- set / verify ----------------------------------------------------------


def test_set_sends_verify_link_in_fragment_and_is_pending(env):
    r = env.client.put("/api/account/recovery-email", json={"email": "Backup@Example.com", "locale": "en"})
    assert r.status_code == 200
    assert r.json() == {"email": "backup@example.com", "verified": False, "pending": True}
    to, content, lang = env.sent[0]
    assert to == "backup@example.com" and lang == "en"
    assert "/recovery-email/verify#token=" in content.button_url
    stored = env.db.tables["recovery_emails"][0]
    assert stored["verify_token_hash"] == recovery_email.hash_token(_token_from(env.sent[0]))


def test_cannot_use_login_email_as_recovery(env):
    r = env.client.put("/api/account/recovery-email", json={"email": "OWNER@example.com"})
    assert r.status_code == 400


def test_resend_to_same_address_is_throttled(env):
    env.client.put("/api/account/recovery-email", json={"email": "backup@example.com"})
    r = env.client.put("/api/account/recovery-email", json={"email": "backup@example.com"})
    assert r.status_code == 429


def test_verify_marks_verified_and_token_is_single_use(env):
    env.client.put("/api/account/recovery-email", json={"email": "backup@example.com"})
    token = _token_from(env.sent[0])
    assert env.client.post("/api/account/recovery-email/verify", json={"token": token}).json()["verified"] is True
    assert env.client.get("/api/account/recovery-email").json()["verified"] is True
    assert env.client.post("/api/account/recovery-email/verify", json={"token": token}).status_code == 404


def test_verify_rejects_expired_token(env):
    env.client.put("/api/account/recovery-email", json={"email": "backup@example.com"})
    env.db.tables["recovery_emails"][0]["verify_expires_at"] = (
        datetime.now(timezone.utc) - timedelta(seconds=1)
    ).isoformat()
    r = env.client.post("/api/account/recovery-email/verify", json={"token": _token_from(env.sent[0])})
    assert r.status_code == 410


def test_verify_rejects_address_already_verified_by_another_account(env):
    env.db.tables["recovery_emails"] = [
        {"user_id": "user-2", "email": "backup@example.com", "verified_at": "2026-10-01T00:00:00+00:00"}
    ]
    env.client.put("/api/account/recovery-email", json={"email": "backup@example.com"})
    r = env.client.post("/api/account/recovery-email/verify", json={"token": _token_from(env.sent[0])})
    assert r.status_code == 409


# --- forgot password via recovery address ---------------------------------


def test_forgot_sends_supabase_recovery_link_to_verified_address(env):
    env.db.tables["recovery_emails"] = [
        {"user_id": "user-1", "email": "backup@example.com", "verified_at": "2026-10-01T00:00:00+00:00"}
    ]
    r = env.client.post("/api/auth/forgot-password", json={"email": "Backup@example.com", "locale": "vi"})
    assert r.status_code == 202
    assert env.db.generated[0]["type"] == "recovery"
    assert env.db.generated[0]["email"] == "owner@example.com"
    assert env.db.generated[0]["options"]["redirect_to"].endswith("/reset-password")
    to, content, _ = env.sent[0]
    assert to == "backup@example.com" and content.button_url == "https://supabase.test/verify?token=abc"


@pytest.mark.parametrize("verified_at", [None])
def test_forgot_ignores_unverified_address(env, verified_at):
    env.db.tables["recovery_emails"] = [{"user_id": "user-1", "email": "backup@example.com", "verified_at": verified_at}]
    assert env.client.post("/api/auth/forgot-password", json={"email": "backup@example.com"}).status_code == 202
    assert env.sent == [] and env.db.generated == []


def test_forgot_gives_same_answer_for_unknown_and_invalid_addresses(env):
    a = env.client.post("/api/auth/forgot-password", json={"email": "nobody@example.com"})
    b = env.client.post("/api/auth/forgot-password", json={"email": "garbage"})
    assert a.status_code == b.status_code == 202 and a.json() == b.json()
    assert env.sent == []
