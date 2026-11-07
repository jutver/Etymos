"""Admin Logs screen backend (api/admin_ops.py) and the log buffer behind it."""
import logging

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import admin_ops
import log_setup
from auth import AuthedUser, verify_supabase_jwt
from log_setup import LogBuffer, _JobFilter, bind_request, job_context, set_request_user, unbind_request

ADMIN = AuthedUser(user_id="aaaaaaaa-0000-0000-0000-000000000001", email=None, role="admin", is_admin=True)
USER = AuthedUser(user_id="bbbbbbbb-0000-0000-0000-000000000002", email=None, role="user", is_admin=False)


@pytest.fixture
def buffer():
    buf = LogBuffer(capacity=50)
    buf.addFilter(_JobFilter())
    log = logging.getLogger("test.admin_ops")
    log.setLevel(logging.DEBUG)
    log.addHandler(buf)
    log.propagate = False
    yield buf, log
    log.removeHandler(buf)
    log.propagate = True


def test_buffer_keeps_rows_in_order_and_returns_only_new_ones(buffer):
    buf, log = buffer
    log.info("one")
    log.warning("two %s", "args")
    first = buf.query()
    assert [r["message"] for r in first["rows"]] == ["one", "two args"]
    assert first["last_seq"] == first["rows"][-1]["seq"]
    log.error("three")
    later = buf.query(after=first["last_seq"])
    assert [r["message"] for r in later["rows"]] == ["three"]


def test_buffer_drops_the_oldest_rows_past_capacity(buffer):
    buf, log = buffer
    for i in range(60):
        log.info("line %d", i)
    result = buf.query(limit=1000)
    assert len(result["rows"]) == 50
    assert result["rows"][0]["message"] == "line 10"
    assert result["oldest_seq"] == result["rows"][0]["seq"]


def test_buffer_filters_by_level_text_job_and_request(buffer):
    buf, log = buffer
    log.debug("noise")
    log.warning("Disk almost full")
    with job_context("job_1234abcd5678"):
        log.info("searching sources")
    token = bind_request("req00001")
    set_request_user(USER.user_id)
    log.info("inside a request")
    unbind_request(token)

    assert [r["message"] for r in buf.query(min_level=logging.WARNING)["rows"]] == ["Disk almost full"]
    assert [r["message"] for r in buf.query(text="disk")["rows"]] == ["Disk almost full"]
    assert [r["message"] for r in buf.query(job="job_1234")["rows"]] == ["searching sources"]
    request_rows = buf.query(request="req00001")["rows"]
    assert [r["message"] for r in request_rows] == ["inside a request"]
    assert request_rows[0]["user"] == USER.user_id
    assert [r["message"] for r in buf.query(user="bbbbbbbb")["rows"]] == ["inside a request"]


def test_buffer_keeps_the_traceback(buffer):
    buf, log = buffer
    try:
        raise ValueError("boom")
    except ValueError:
        log.exception("it failed")
    row = buf.query()["rows"][-1]
    assert row["message"] == "it failed"
    assert "ValueError: boom" in row["exc"]
    assert buf.query(text="boom")["rows"] == [row]


def test_buffer_returns_the_newest_rows_when_too_many_match(buffer):
    buf, log = buffer
    for i in range(10):
        log.info("n%d", i)
    result = buf.query(limit=3)
    assert [r["message"] for r in result["rows"]] == ["n7", "n8", "n9"]
    assert result["truncated"] is True


def test_set_level_changes_the_running_level():
    root = logging.getLogger()
    before = root.level
    try:
        assert log_setup.set_level("debug") == "DEBUG"
        assert root.level == logging.DEBUG
        assert logging.getLogger("httpx").level == logging.WARNING
        with pytest.raises(ValueError):
            log_setup.set_level("loud")
    finally:
        root.setLevel(before)


def test_tail_reads_the_end_and_filters(tmp_path):
    path = tmp_path / "api.err.log"
    path.write_text("".join(f"line {i}{' ERROR' if i % 10 == 0 else ''}\n" for i in range(100)))
    rows, more = admin_ops.tail_lines(path, 5)
    assert rows == [f"line {i}" for i in range(95, 100)]
    assert more is True
    rows, _ = admin_ops.tail_lines(path, 3, "error")
    assert rows == ["line 70 ERROR", "line 80 ERROR", "line 90 ERROR"]


@pytest.fixture
def api(tmp_path, monkeypatch):
    app = FastAPI()
    app.include_router(admin_ops.router)
    current = {"user": ADMIN}
    app.dependency_overrides[verify_supabase_jwt] = lambda: current["user"]
    monkeypatch.setattr(admin_ops, "LOG_DIR", tmp_path)
    monkeypatch.setattr(admin_ops, "get_client", lambda: None)
    (tmp_path / "deploy.log").write_text("2026-11-07 10:00:00 Deployed abc1234\n")
    return TestClient(app), current


@pytest.mark.parametrize("method,path", [
    ("get", "/api/admin/logs"),
    ("get", "/api/admin/logs/files"),
    ("get", "/api/admin/logs/files/deploy"),
    ("get", "/api/admin/server"),
    ("post", "/api/admin/server/actions/dump-threads"),
])
def test_everything_is_admin_only(api, method, path):
    client, current = api
    current["user"] = USER
    assert getattr(client, method)(path).status_code == 403


def test_live_log_endpoint_returns_buffered_rows(api):
    client, _ = api
    # Under pytest configure_logging() doesn't run, so attach the buffer here.
    log = logging.getLogger("api.test")
    log.addHandler(log_setup.LOG_BUFFER)
    try:
        log.warning("visible to admins")
    finally:
        log.removeHandler(log_setup.LOG_BUFFER)
    body = client.get("/api/admin/logs", params={"q": "visible to admins"}).json()
    assert [r["message"] for r in body["rows"]] == ["visible to admins"]
    assert body["capacity"] == log_setup.LOG_BUFFER.capacity


def test_log_files_are_a_fixed_list(api):
    client, _ = api
    files = client.get("/api/admin/logs/files").json()["files"]
    assert {f["name"] for f in files} == set(admin_ops.LOG_FILES)
    assert next(f for f in files if f["name"] == "deploy")["exists"] is True
    body = client.get("/api/admin/logs/files/deploy").json()
    assert body["lines"] == ["2026-11-07 10:00:00 Deployed abc1234"]
    missing = client.get("/api/admin/logs/files/tests").json()
    assert missing["exists"] is False and missing["lines"] == []
    for name in ("..%2F..%2Fetc%2Fpasswd", "passwd", "api.err.log"):
        assert client.get(f"/api/admin/logs/files/{name}").status_code == 404


def test_server_status_reports_process_and_jobs(api):
    client, _ = api
    body = client.get("/api/admin/server").json()
    assert body["process"]["pid"] > 0
    assert set(body["jobs"]) == {"active", "recent", "counts"}
    assert body["gpu"]["queue"]["slots"] >= 1


def test_actions_are_a_fixed_list(api):
    client, _ = api
    assert client.post("/api/admin/server/actions/rm-rf").status_code == 404
    assert client.post("/api/admin/server/actions/dump-threads").json()["threads"] >= 1


def test_log_level_action(api):
    client, _ = api
    root = logging.getLogger()
    before = root.level
    try:
        assert client.post("/api/admin/server/actions/log-level").status_code == 422
        body = client.post("/api/admin/server/actions/log-level", json={"level": "DEBUG"}).json()
        assert body["level"] == "DEBUG"
        assert root.level == logging.DEBUG
    finally:
        root.setLevel(before)


def test_restart_refuses_when_not_supervised_or_checks_are_running(api, monkeypatch):
    client, _ = api
    started = []
    monkeypatch.setattr(admin_ops, "_restart_api", lambda: started.append(True))
    monkeypatch.setattr(admin_ops, "_supervised", lambda: False)
    assert client.post("/api/admin/server/actions/restart-api").status_code == 409
    monkeypatch.setattr(admin_ops, "_supervised", lambda: True)
    monkeypatch.setattr(admin_ops, "active_count", lambda: 2)
    refused = client.post("/api/admin/server/actions/restart-api")
    assert refused.status_code == 409 and "2 check(s)" in refused.json()["detail"]
    assert started == []
    forced = client.post("/api/admin/server/actions/restart-api", json={"force": True}).json()
    assert forced["restarting"] is True and forced["lost_checks"] == 2
    assert started == [True]
