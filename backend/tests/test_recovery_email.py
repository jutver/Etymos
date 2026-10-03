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
        users = {"user-1": "owner@example.com", "user-2": "work@example.com", "user-3": "third@example.com"}
        db = self

        class _Admin:
            def get_user_by_id(self, uid):
                return SimpleNamespace(user=SimpleNamespace(email=users[uid], user_metadata={"display_name": f"Name {uid}"}))

            def generate_link(self, params):
                db.generated.append(params)
                return SimpleNamespace(properties=SimpleNamespace(hashed_token="hashed-abc"))

        self.auth = SimpleNamespace(admin=_Admin())

    def table(self, name):
        return _Query(self, name)


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()
    sent: list = []
    monkeypatch.setattr(recovery_email, "get_client", lambda: db)
    monkeypatch.setattr(mailer, "is_configured", lambda: True)
    monkeypatch.setattr(mailer, "send_email", lambda to, content: sent.append((to, content)))

    current = {"user": AuthedUser(user_id="user-1", email="owner@example.com", role="user", is_admin=False)}
    app = FastAPI()
    app.state.limiter = rate_limit.limiter
    app.add_middleware(SlowAPIMiddleware)
    app.include_router(recovery_email.router)
    app.dependency_overrides[verify_supabase_jwt] = lambda: current["user"]
    rate_limit.limiter.reset()
    return SimpleNamespace(client=TestClient(app), db=db, sent=sent, current=current)


def _code_from(sent_item) -> str:
    return sent_item[1].code


def _verified(email="backup@example.com", user_id="user-1"):
    return {"user_id": user_id, "email": email, "verified_at": "2026-10-01T00:00:00+00:00"}


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


# --- confirming the address (signed in) ----------------------------------


def test_set_emails_a_confirm_code_and_is_pending(env):
    r = env.client.put("/api/account/recovery-email", json={"email": "Backup@Example.com"})
    assert r.json() == {"email": "backup@example.com", "verified": False, "pending": True}
    to, content = env.sent[0]
    assert to == "backup@example.com"
    assert content.button_url is None and len(_code_from(env.sent[0])) == 6
    stored = env.db.tables["recovery_emails"][0]
    assert stored["verify_code_hash"] == recovery_email.hash_code("confirm", "user-1", _code_from(env.sent[0]))


def test_cannot_use_login_email_as_recovery(env):
    r = env.client.put("/api/account/recovery-email", json={"email": "OWNER@example.com"})
    assert r.status_code == 400 and r.json()["detail"] == "same_as_login"


def test_resend_to_same_address_is_throttled(env):
    env.client.put("/api/account/recovery-email", json={"email": "backup@example.com"})
    r = env.client.put("/api/account/recovery-email", json={"email": "backup@example.com"})
    assert r.status_code == 429


def test_correct_code_confirms_and_cannot_be_reused(env):
    env.client.put("/api/account/recovery-email", json={"email": "backup@example.com"})
    code = _code_from(env.sent[0])
    assert env.client.post("/api/account/recovery-email/confirm", json={"code": code}).json()["verified"] is True
    assert env.client.get("/api/account/recovery-email").json()["verified"] is True
    assert env.client.post("/api/account/recovery-email/confirm", json={"code": code}).status_code == 400


def test_wrong_code_then_lockout_after_max_attempts(env):
    env.client.put("/api/account/recovery-email", json={"email": "backup@example.com"})
    real = _code_from(env.sent[0])
    wrong = "000000" if real != "000000" else "111111"
    for _ in range(recovery_email.MAX_ATTEMPTS - 1):
        r = env.client.post("/api/account/recovery-email/confirm", json={"code": wrong})
        assert r.status_code == 400 and r.json()["detail"] == "wrong_code"
    r = env.client.post("/api/account/recovery-email/confirm", json={"code": wrong})
    assert r.status_code == 429
    # The code is discarded: even the right one no longer works.
    assert env.client.post("/api/account/recovery-email/confirm", json={"code": real}).json()["detail"] == "no_code"


def test_expired_code_is_rejected(env):
    env.client.put("/api/account/recovery-email", json={"email": "backup@example.com"})
    env.db.tables["recovery_emails"][0]["verify_expires_at"] = (
        datetime.now(timezone.utc) - timedelta(seconds=1)
    ).isoformat()
    r = env.client.post("/api/account/recovery-email/confirm", json={"code": _code_from(env.sent[0])})
    assert r.status_code == 410


def test_several_accounts_can_confirm_the_same_address(env):
    env.db.tables["recovery_emails"] = [_verified(user_id="user-2")]
    env.client.put("/api/account/recovery-email", json={"email": "backup@example.com"})
    r = env.client.post("/api/account/recovery-email/confirm", json={"code": _code_from(env.sent[0])})
    assert r.status_code == 200 and r.json()["verified"] is True


def test_code_must_be_six_digits(env):
    assert env.client.post("/api/account/recovery-email/confirm", json={"code": "12ab56"}).status_code == 422


# --- recovering the account (signed out) ---------------------------------


def test_request_sends_reset_code_to_confirmed_address(env):
    env.db.tables["recovery_emails"] = [_verified()]
    r = env.client.post("/api/auth/recovery/request", json={"email": "Backup@example.com"})
    assert r.status_code == 202
    to, content = env.sent[0]
    assert to == "backup@example.com" and len(content.code) == 6


def test_request_ignores_unconfirmed_and_unknown_addresses_with_same_answer(env):
    env.db.tables["recovery_emails"] = [{"user_id": "user-1", "email": "backup@example.com", "verified_at": None}]
    a = env.client.post("/api/auth/recovery/request", json={"email": "backup@example.com"})
    b = env.client.post("/api/auth/recovery/request", json={"email": "nobody@example.com"})
    c = env.client.post("/api/auth/recovery/request", json={"email": "garbage"})
    assert a.status_code == b.status_code == c.status_code == 202 and a.json() == b.json() == c.json()
    assert env.sent == []


def _verify(env, code, user_id=None, email="backup@example.com"):
    body = {"email": email, "code": code}
    if user_id:
        body["user_id"] = user_id
    return env.client.post("/api/auth/recovery/verify", json=body)


def test_correct_code_lists_accounts_then_recovers_the_chosen_one(env):
    env.db.tables["recovery_emails"] = [_verified(user_id="user-1"), _verified(user_id="user-2")]
    env.client.post("/api/auth/recovery/request", json={"email": "backup@example.com"})
    assert len(env.sent) == 1  # one email for the address, not one per account
    assert "owner@example.com" in env.sent[0][1].paragraphs[0] and "work@example.com" in env.sent[0][1].paragraphs[0]
    code = _code_from(env.sent[0])

    listed = _verify(env, code)
    assert listed.status_code == 200
    assert listed.json() == {
        "accounts": [
            {"user_id": "user-1", "email": "owner@example.com", "name": "Name user-1"},
            {"user_id": "user-2", "email": "work@example.com", "name": "Name user-2"},
        ]
    }
    assert env.db.generated == []  # listing doesn't spend the code or mint anything

    chosen = _verify(env, code, user_id="user-2")
    assert chosen.json() == {"token_hash": "hashed-abc"}
    assert env.db.generated == [{"type": "recovery", "email": "work@example.com"}]
    # Spent for every account on the address.
    assert _verify(env, code).status_code == 400
    assert _verify(env, code, user_id="user-1").status_code == 400


def test_cannot_choose_an_account_the_code_does_not_cover(env):
    env.db.tables["recovery_emails"] = [_verified(user_id="user-1")]
    env.client.post("/api/auth/recovery/request", json={"email": "backup@example.com"})
    code = _code_from(env.sent[0])
    # user-3 confirmed the address after the code went out.
    env.db.tables["recovery_emails"].append(_verified(user_id="user-3"))
    assert [a["user_id"] for a in _verify(env, code).json()["accounts"]] == ["user-1"]
    assert _verify(env, code, user_id="user-3").status_code == 400
    assert _verify(env, code, user_id="someone-else").status_code == 400
    assert env.db.generated == []


def test_verify_gives_one_generic_error_for_every_failure(env):
    env.db.tables["recovery_emails"] = [_verified()]
    env.client.post("/api/auth/recovery/request", json={"email": "backup@example.com"})
    real = _code_from(env.sent[0])
    wrong = "000000" if real != "000000" else "111111"
    unknown = env.client.post("/api/auth/recovery/verify", json={"email": "nobody@example.com", "code": real})
    bad = env.client.post("/api/auth/recovery/verify", json={"email": "backup@example.com", "code": wrong})
    assert unknown.status_code == bad.status_code == 400
    assert unknown.json() == bad.json() == {"detail": "invalid_code"}
    assert env.db.generated == []


def test_confirm_code_cannot_be_used_to_reset(env):
    env.client.put("/api/account/recovery-email", json={"email": "backup@example.com"})
    confirm_code = _code_from(env.sent[0])
    env.client.post("/api/account/recovery-email/confirm", json={"code": confirm_code})
    r = _verify(env, confirm_code)
    assert r.status_code == 400 and env.db.generated == []
