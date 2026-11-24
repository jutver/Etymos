"""Tests for SSE status/job endpoints, job pub/sub, and account preferences API."""
from __future__ import annotations

import json
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import app as api_app
import job_manager
from auth import AuthedUser, verify_supabase_jwt


USER_A = AuthedUser(user_id="user-a-0001", email="a@etymos.site", role="user", is_admin=False)
USER_B = AuthedUser(user_id="user-b-0002", email="b@etymos.site", role="user", is_admin=False)


class _PrefQuery:
    def __init__(self, db, table_name):
        self.db = db
        self.table_name = table_name
        self.filters = []
        self.op = "select"
        self.payload = None

    def select(self, cols):
        self.cols = cols
        return self

    def limit(self, *_):
        return self

    def eq(self, col, val):
        self.filters.append(lambda r: r.get(col) == val)
        return self

    def update(self, payload):
        self.op = "update"
        self.payload = payload
        return self

    def execute(self):
        if self.db.missing_column:
            raise RuntimeError("column profiles.theme_preference does not exist (42703)")
        rows = self.db.profiles
        matched = [r for r in rows if all(f(r) for f in self.filters)]
        if self.op == "select":
            return SimpleNamespace(data=[dict(r) for r in matched])
        if self.op == "update":
            for r in matched:
                r.update(self.payload)
            return SimpleNamespace(data=[dict(r) for r in matched])
        raise AssertionError(self.op)


class _FakePrefsDB:
    def __init__(self):
        self.missing_column = False
        self.profiles = [
            {"id": USER_A.user_id, "email": USER_A.email, "theme_preference": "light", "email_on_check_done": False},
        ]

    def table(self, name):
        assert name == "profiles"
        return _PrefQuery(self, name)


def _parse_sse_text(raw: str) -> list[tuple[str, dict]]:
    events: list[tuple[str, dict]] = []
    for block in raw.strip().split("\n\n"):
        if not block.strip():
            continue
        evt_name = "message"
        data_lines = []
        for line in block.splitlines():
            if line.startswith("event:"):
                evt_name = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                data_lines.append(line.split(":", 1)[1].strip())
        if data_lines:
            events.append((evt_name, json.loads("\n".join(data_lines))))
    return events


@pytest.fixture
def env(monkeypatch):
    api_app.reset_sse_shutdown()
    job_manager._JOBS.clear()
    job_manager._TIMES.clear()
    with job_manager._LOCK:
        job_manager._SUBSCRIBERS.clear()

    db = _FakePrefsDB()
    active_user = {"user": USER_A}

    def override_auth():
        if active_user["user"] is None:
            from fastapi import HTTPException
            raise HTTPException(status_code=401, detail="Not authenticated")
        return active_user["user"]

    api_app.app.dependency_overrides[verify_supabase_jwt] = override_auth
    monkeypatch.setattr(api_app, "get_client", lambda: db)
    yield SimpleNamespace(client=TestClient(api_app.app), db=db, auth=active_user, monkeypatch=monkeypatch)

    api_app.app.dependency_overrides.clear()
    api_app.reset_sse_shutdown()
    job_manager._JOBS.clear()
    job_manager._TIMES.clear()


def test_status_stream_emits_status_and_exits_on_shutdown(env):
    def trigger_shutdown():
        time.sleep(0.05)
        api_app.signal_sse_shutdown()

    threading.Thread(target=trigger_shutdown, daemon=True).start()
    with env.client.stream("GET", "/api/status/stream") as resp:
        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers["content-type"]
        assert resp.headers.get("x-accel-buffering") == "no"
        raw = "".join(resp.iter_text())

    events = _parse_sse_text(raw)
    assert events[0][0] == "status"
    assert events[0][1]["status"] == "ok"


def test_single_job_stream_auth_and_live_terminal_delivery(env):
    jid = job_manager.create_job("pdf", "Paper.pdf", user_id=USER_A.user_id)

    env.auth["user"] = None
    assert env.client.get(f"/api/jobs/{jid}/stream").status_code == 401

    env.auth["user"] = USER_B
    # require_owner_or_admin raises 404 on mismatch to prevent cross-user enumeration.
    assert env.client.get(f"/api/jobs/{jid}/stream").status_code == 404

    env.auth["user"] = USER_A
    assert env.client.get("/api/jobs/job_missing/stream").status_code == 404

    def finish():
        time.sleep(0.05)
        job_manager.update_job(jid, status="processing", progress=50, current_step="searching", message="Searching")
        time.sleep(0.05)
        job_manager.update_job(jid, status="completed", progress=100, current_step="completed",
                               message="Analysis complete", report_id="rep-1")

    threading.Thread(target=finish, daemon=True).start()
    with env.client.stream("GET", f"/api/jobs/{jid}/stream") as resp:
        assert resp.status_code == 200
        raw = "".join(resp.iter_text())

    events = _parse_sse_text(raw)
    statuses = [payload["status"] for name, payload in events if name == "job"]
    assert statuses[0] == "queued"
    assert "processing" in statuses
    assert statuses[-1] == "completed"
    assert events[-1][1]["report_id"] == "rep-1"

    # Subsequent connection on an already-completed job emits once and closes immediately.
    with env.client.stream("GET", f"/api/jobs/{jid}/stream") as resp:
        assert resp.status_code == 200
        already_done = _parse_sse_text("".join(resp.iter_text()))
    assert len(already_done) == 1
    assert already_done[0][1]["status"] == "completed"


def test_multi_jobs_stream_precedence_filtering_and_updates(env):
    jid_a = job_manager.create_job("pdf", "Mine.pdf", user_id=USER_A.user_id)
    jid_b = job_manager.create_job("pdf", "Foreign.pdf", user_id=USER_B.user_id)

    env.auth["user"] = None
    assert env.client.get(f"/api/jobs/stream?job_ids={jid_a}").status_code == 401

    env.auth["user"] = USER_A

    def settle():
        time.sleep(0.05)
        job_manager.update_job(jid_a, status="failed", current_step="failed", message="Failed", error="Corrupt PDF")

    threading.Thread(target=settle, daemon=True).start()
    # Verifies /api/jobs/stream matches before /api/jobs/{job_id}, and foreign IDs go into missing_job_ids.
    with env.client.stream("GET", f"/api/jobs/stream?job_ids={jid_a},{jid_b},job_none") as resp:
        assert resp.status_code == 200
        raw = "".join(resp.iter_text())

    events = _parse_sse_text(raw)
    assert events[0][0] == "snapshot"
    assert [j["job_id"] for j in events[0][1]["jobs"]] == [jid_a]
    assert set(events[0][1]["missing_job_ids"]) == {jid_b, "job_none"}
    assert events[-1][0] == "job"
    assert events[-1][1]["job_id"] == jid_a
    assert events[-1][1]["status"] == "failed"


def test_account_preferences_crud_and_validation(env):
    env.auth["user"] = None
    assert env.client.get("/api/account/preferences").status_code == 401
    assert env.client.put("/api/account/preferences", json={"theme_preference": "dark"}).status_code == 401

    env.auth["user"] = USER_A
    r = env.client.get("/api/account/preferences")
    assert r.status_code == 200
    assert r.json() == {"theme_preference": "light", "email_on_check_done": False}

    # Pre-migration 42703 fallback returns safe defaults on GET and 503 on PUT.
    env.db.missing_column = True
    assert env.client.get("/api/account/preferences").json() == {"theme_preference": "light", "email_on_check_done": False}
    assert env.client.put("/api/account/preferences", json={"theme_preference": "dark"}).status_code == 503
    env.db.missing_column = False

    # Partial and full updates persist correctly.
    r = env.client.put("/api/account/preferences", json={"theme_preference": "dark"})
    assert r.status_code == 200
    assert r.json() == {"theme_preference": "dark", "email_on_check_done": False}

    r = env.client.put("/api/account/preferences", json={"email_on_check_done": True})
    assert r.status_code == 200
    assert r.json() == {"theme_preference": "dark", "email_on_check_done": True}

    assert env.client.put("/api/account/preferences", json={}).status_code == 400
    assert env.client.put("/api/account/preferences", json={"theme_preference": "sepia"}).status_code == 422

    env.monkeypatch.setattr(api_app, "get_client", lambda: None)
    assert env.client.get("/api/account/preferences").status_code == 503
