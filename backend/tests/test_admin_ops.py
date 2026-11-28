"""Admin Logs screen backend (api/admin_ops.py) and the log buffer behind it."""
import logging

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import admin_log
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
    monkeypatch.setattr(admin_log, "get_client", lambda: None)
    (tmp_path / "deploy.log").write_text("2026-11-07 10:00:00 Deployed abc1234\n")
    return TestClient(app), current


@pytest.mark.parametrize("method,path", [
    ("get", "/api/admin/logs"),
    ("get", "/api/admin/logs/files"),
    ("get", "/api/admin/logs/files/deploy"),
    ("get", "/api/admin/server"),
    ("post", "/api/admin/server/actions/dump-threads"),
    ("post", "/api/admin/server/actions/shutdown-api"),
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


class _FakeRpcClient:
    def __init__(self):
        self.calls = []

    def rpc(self, name, params):
        self.calls.append((name, params))
        return self

    def execute(self):
        return None


def test_record_admin_action_names_the_admin_and_request(monkeypatch):
    fake = _FakeRpcClient()
    monkeypatch.setattr(admin_log, "get_client", lambda: fake)
    token = bind_request("req12345", "POST", "/api/admin/server/actions/free-gpu")
    try:
        admin_log.record_admin_action(ADMIN.user_id, "server.free_gpu", target_table="server", metadata={"freed": []})
    finally:
        unbind_request(token)
    [(name, params)] = fake.calls
    assert name == "log_admin_action"
    assert params["p_actor_id"] == ADMIN.user_id and params["p_source"] == "backend"
    assert params["p_metadata"] == {"freed": [], "request_id": "req12345"}


def test_admin_reading_someone_elses_report_is_logged_once_per_window(monkeypatch):
    from auth import require_owner_or_admin

    fake = _FakeRpcClient()
    monkeypatch.setattr(admin_log, "get_client", lambda: fake)
    monkeypatch.setattr(admin_log, "_recent_views", {})
    token = bind_request("req00002", "GET", "/api/reports/rep_abc/source-pdf")
    try:
        require_owner_or_admin(USER.user_id, ADMIN)
        require_owner_or_admin(USER.user_id, ADMIN)  # same report again: not logged twice
        require_owner_or_admin(ADMIN.user_id, ADMIN)  # the admin's own: not an admin action
    finally:
        unbind_request(token)
    [(_, params)] = fake.calls
    assert params["p_action"] == "user_data.viewed"
    assert params["p_target_user_id"] == USER.user_id
    assert params["p_target_id"] == "rep_abc" and params["p_target_table"] == "documents"


def test_recording_never_fails_the_action(monkeypatch):
    class Broken:
        def rpc(self, *a):
            raise RuntimeError("database down")

    monkeypatch.setattr(admin_log, "get_client", lambda: Broken())
    admin_log.record_admin_action(ADMIN.user_id, "support.replied")  # no exception


def test_default_supervisorctl_prefers_env_then_venv_then_path(tmp_path, monkeypatch):
    conf = tmp_path / "supervisord.conf"
    conf.write_text("[supervisord]\n", encoding="utf-8")
    monkeypatch.setattr(admin_ops, "BACKEND_DIR", tmp_path)
    monkeypatch.setattr(admin_ops, "SUPERVISOR_CONF", conf)

    # 1. Explicit SUPERVISORCTL env override wins first.
    monkeypatch.setenv("SUPERVISORCTL", str(tmp_path / "custom-supervisorctl"))
    assert admin_ops._default_supervisorctl() == tmp_path / "custom-supervisorctl"

    # 2. .venv/bin/supervisorctl wins over $PATH when it exists.
    monkeypatch.delenv("SUPERVISORCTL", raising=False)
    venv_bin = tmp_path / ".venv" / "bin" / "supervisorctl"
    venv_bin.parent.mkdir(parents=True)
    venv_bin.write_text("#!/bin/sh\n", encoding="utf-8")
    path_bin = tmp_path / "global-supervisorctl"
    path_bin.write_text("#!/bin/sh\n", encoding="utf-8")
    monkeypatch.setattr(admin_ops.shutil, "which", lambda _cmd: str(path_bin))
    assert admin_ops._default_supervisorctl() == venv_bin

    # 3. $PATH fallback is used when .venv/bin/supervisorctl does not exist.
    venv_bin.unlink()
    resolved = admin_ops._default_supervisorctl()
    assert resolved == path_bin
    monkeypatch.setattr(admin_ops, "SUPERVISORCTL", resolved)
    assert admin_ops._supervised() is True

    # 4. Non-existent venv fallback keeps _supervised() False when neither exists.
    monkeypatch.setattr(admin_ops.shutil, "which", lambda _cmd: None)
    missing = admin_ops._default_supervisorctl()
    assert missing == venv_bin
    monkeypatch.setattr(admin_ops, "SUPERVISORCTL", missing)
    assert admin_ops._supervised() is False


def test_shutdown_refuses_when_checks_running_and_audits_before_stopping(api, monkeypatch):
    client, _ = api
    events: list[tuple] = []

    monkeypatch.setattr(admin_ops, "_shutdown_api", lambda supervised: events.append(("shutdown", supervised)))
    monkeypatch.setattr(
        admin_ops,
        "record_admin_action",
        lambda actor_id, action, **kw: events.append(("audit", actor_id, action, kw)),
    )

    # Refused without force when checks are active.
    monkeypatch.setattr(admin_ops, "_supervised", lambda: True)
    monkeypatch.setattr(admin_ops, "active_count", lambda: 2)
    refused = client.post("/api/admin/server/actions/shutdown-api")
    assert refused.status_code == 409
    assert "2 check(s)" in refused.json()["detail"]
    assert events == []

    # Forced shutdown while supervised records audit first, then shuts down.
    forced = client.post("/api/admin/server/actions/shutdown-api", json={"force": True})
    assert forced.status_code == 200
    body = forced.json()
    assert body["action"] == "shutdown-api"
    assert body["shutting_down"] is True
    assert body["lost_checks"] == 2
    assert body["supervised"] is True
    assert events[0][0] == "audit" and events[0][2] == "server.shutdown_api"
    assert events[1] == ("shutdown", True)

    # Standalone (not supervised) shutdown also works cleanly when forced or idle.
    events.clear()
    monkeypatch.setattr(admin_ops, "_supervised", lambda: False)
    monkeypatch.setattr(admin_ops, "active_count", lambda: 0)
    standalone = client.post("/api/admin/server/actions/shutdown-api", json={"force": False})
    assert standalone.status_code == 200
    s_body = standalone.json()
    assert s_body["shutting_down"] is True
    assert s_body["lost_checks"] == 0
    assert s_body["supervised"] is False
    assert events[0][0] == "audit" and events[0][2] == "server.shutdown_api"
    assert events[1] == ("shutdown", False)


def test_ws_live_logs_rejects_unauthorized_and_non_admin(api, monkeypatch):
    import time
    from fastapi import HTTPException
    from starlette.websockets import WebSocketDisconnect

    client, _ = api

    def fake_verify(token: str):
        if token == "bad":
            raise HTTPException(status_code=401, detail="Invalid token.")
        if token == "non-admin":
            return USER, time.time() + 60
        return ADMIN, time.time() + 60

    monkeypatch.setattr(admin_ops, "verify_jwt_token", fake_verify)

    with client.websocket_connect("/api/admin/logs/ws") as ws:
        ws.send_json({"type": "auth", "token": "bad"})
        err = ws.receive_json()
        assert err["type"] == "error" and err["code"] == "unauthorized"
        with pytest.raises(WebSocketDisconnect) as exc_info:
            ws.receive_json()
        assert exc_info.value.code == admin_ops.WS_CLOSE_UNAUTHORIZED

    with client.websocket_connect("/api/admin/logs/ws") as ws:
        ws.send_json({"type": "auth", "token": "non-admin"})
        err = ws.receive_json()
        assert err["type"] == "error" and err["code"] == "forbidden"
        with pytest.raises(WebSocketDisconnect) as exc_info:
            ws.receive_json()
        assert exc_info.value.code == admin_ops.WS_CLOSE_FORBIDDEN


def test_ws_live_logs_streams_filters_pause_resume_and_expiry(api, monkeypatch):
    import time
    from starlette.websockets import WebSocketDisconnect

    client, _ = api
    exp_box = {"exp": time.time() + 60}

    def fake_verify(token: str):
        if token == "expiring":
            return ADMIN, time.time() + 0.08
        return ADMIN, exp_box["exp"]

    monkeypatch.setattr(admin_ops, "verify_jwt_token", fake_verify)

    log = logging.getLogger("api.ws_test")
    log.setLevel(logging.DEBUG)
    log.addHandler(log_setup.LOG_BUFFER)
    log.propagate = False
    try:
        log.info("ws-before-connect")
        with client.websocket_connect("/api/admin/logs/ws") as ws:
            ws.send_json({"type": "auth", "token": "good", "after": 0, "limit": 50, "filters": {"q": "ws-"}})
            auth_ok = ws.receive_json()
            assert auth_ok["type"] == "auth_ok"
            snap = ws.receive_json()
            assert snap["type"] == "snapshot"
            assert any(r["message"] == "ws-before-connect" for r in snap["rows"])
            last_seq = snap["last_seq"]

            # Live row arrives immediately.
            log.info("ws-live-line")
            msg = ws.receive_json()
            assert msg["type"] == "rows"
            assert [r["message"] for r in msg["rows"]] == ["ws-live-line"]
            last_seq = msg["last_seq"]

            # Live filter switch resets snapshot to matching lines only.
            ws.send_json({"type": "subscribe", "after": 0, "limit": 50, "filters": {"level": "WARNING", "q": "ws-"}})
            filtered_snap = ws.receive_json()
            assert filtered_snap["type"] == "snapshot"
            assert filtered_snap["rows"] == []

            log.warning("ws-warn-one")
            warn_msg = ws.receive_json()
            assert [r["message"] for r in warn_msg["rows"]] == ["ws-warn-one"]
            paused_seq = warn_msg["last_seq"]

            # Pause suppresses live delivery; resume delivers missed lines without duplicates.
            ws.send_json({"type": "pause"})
            log.warning("ws-while-paused")
            ws.send_json({"type": "resume", "after": paused_seq})
            resumed = ws.receive_json()
            assert resumed["type"] == "snapshot"
            assert [r["message"] for r in resumed["rows"]] == ["ws-while-paused"]

            # Refresh auth updates session token cleanly.
            ws.send_json({"type": "refresh_auth", "token": "good"})
            ws.send_json({"type": "ping"})
            assert ws.receive_json() == {"type": "pong"}

        # Expiring token triggers server-side closure with 4401.
        with client.websocket_connect("/api/admin/logs/ws") as ws:
            ws.send_json({"type": "auth", "token": "expiring", "after": last_seq, "limit": 10})
            assert ws.receive_json()["type"] == "auth_ok"
            assert ws.receive_json()["type"] == "snapshot"
            err = ws.receive_json()
            assert err["type"] == "error" and err["code"] == "unauthorized"
            with pytest.raises(WebSocketDisconnect) as exc_info:
                ws.receive_json()
            assert exc_info.value.code == admin_ops.WS_CLOSE_UNAUTHORIZED
    finally:
        log.removeHandler(log_setup.LOG_BUFFER)
        log.propagate = True


def test_log_buffer_subscriber_sets_dropped_flag_on_overflow():
    import asyncio

    async def _run():
        buf = LogBuffer(capacity=20)
        sub = buf.subscribe(asyncio.get_running_loop(), maxsize=2)
        sub.enqueue({"seq": 1})
        sub.enqueue({"seq": 2})
        sub.enqueue({"seq": 3})
        assert sub.dropped is True
        items = [await sub.queue.get(), await sub.queue.get()]
        assert [i["seq"] for i in items] == [2, 3]
        buf.unsubscribe(sub)

    asyncio.run(_run())


def test_ws_server_status_streams_refreshes_and_enforces_expiry(api, monkeypatch):
    import time
    from fastapi import HTTPException
    from starlette.websockets import WebSocketDisconnect

    client, _ = api

    def fake_verify(token: str):
        if token == "non-admin":
            return USER, time.time() + 60
        if token == "expiring":
            return ADMIN, time.time() + 0.08
        if token == "good":
            return ADMIN, time.time() + 60
        raise HTTPException(status_code=401, detail="Invalid token.")

    monkeypatch.setattr(admin_ops, "verify_jwt_token", fake_verify)

    with client.websocket_connect("/api/admin/server/ws") as ws:
        ws.send_json({"type": "auth", "token": "non-admin"})
        err = ws.receive_json()
        assert err["type"] == "error" and err["code"] == "forbidden"
        with pytest.raises(WebSocketDisconnect) as exc_info:
            ws.receive_json()
        assert exc_info.value.code == admin_ops.WS_CLOSE_FORBIDDEN

    with client.websocket_connect("/api/admin/server/ws") as ws:
        ws.send_json({"type": "auth", "token": "good"})
        assert ws.receive_json()["type"] == "auth_ok"
        first = ws.receive_json()
        assert first["type"] == "status"
        assert first["data"]["process"]["pid"] > 0

        ws.send_json({"type": "refresh"})
        refreshed = ws.receive_json()
        assert refreshed["type"] == "status"
        assert set(refreshed["data"]["jobs"]) == {"active", "recent", "counts"}

        ws.send_json({"type": "refresh_auth", "token": "good"})
        ws.send_json({"type": "ping"})
        assert ws.receive_json() == {"type": "pong"}

    with client.websocket_connect("/api/admin/server/ws") as ws:
        ws.send_json({"type": "auth", "token": "expiring"})
        assert ws.receive_json()["type"] == "auth_ok"
        assert ws.receive_json()["type"] == "status"
        err = ws.receive_json()
        assert err["type"] == "error" and err["code"] == "unauthorized"
        with pytest.raises(WebSocketDisconnect) as exc_info:
            ws.receive_json()
        assert exc_info.value.code == admin_ops.WS_CLOSE_UNAUTHORIZED


def test_ws_handshake_ignores_disconnect_during_accept_or_auth_ok(monkeypatch):
    import asyncio
    from starlette.websockets import WebSocketDisconnect

    monkeypatch.setattr(admin_ops, "_authenticate_ws_token", lambda _tok: (ADMIN, 9999999999.0))

    class DisconnectOnAccept:
        async def accept(self):
            raise WebSocketDisconnect(code=1000)

    assert asyncio.run(admin_ops._ws_handshake_auth(DisconnectOnAccept())) is None

    class DisconnectOnAuthOk:
        async def accept(self):
            return None

        async def receive_json(self):
            return {"type": "auth", "token": "good"}

        async def send_json(self, _payload):
            raise WebSocketDisconnect(code=1006)

    assert asyncio.run(admin_ops._ws_handshake_auth(DisconnectOnAuthOk())) is None


# --- TUI local ops auth, managed services, WS interval & audit extensions ---

def test_local_ops_token_accepts_loopback_and_rejects_proxy_or_bad_token(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import local_ops_auth

    app = FastAPI()
    app.include_router(admin_ops.router)
    client = TestClient(app)

    tok = local_ops_auth.init_local_ops_token(tmp_path)
    try:
        token_file = tmp_path / ".local_ops_token"
        assert token_file.exists()
        assert (token_file.stat().st_mode & 0o777) == 0o600
        assert local_ops_auth.read_local_ops_token(tmp_path) == tok

        # Unauthenticated fails (401); valid loopback X-Local-Ops-Token succeeds (200)
        assert client.get("/api/admin/server").status_code == 401
        ok = client.get("/api/admin/server", headers={"X-Local-Ops-Token": tok})
        assert ok.status_code == 200
        assert ok.json()["process"]["pid"] > 0

        # Bad token fails (401)
        assert client.get("/api/admin/server", headers={"X-Local-Ops-Token": "wrong"}).status_code == 401

        # Any proxy forwarding header MUST be rejected (403) even with the valid token
        for hdr in ("CF-Connecting-IP", "X-Forwarded-For", "X-Real-IP", "Forwarded"):
            spoofed = client.get(
                "/api/admin/server",
                headers={"X-Local-Ops-Token": tok, hdr: "203.0.113.10"},
            )
            assert spoofed.status_code == 403, f"expected 403 for {hdr}"

        # Non-loopback host rejected directly by verify_local_ops_token
        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc_info:
            local_ops_auth.verify_local_ops_token(tok, client_host="203.0.113.5", headers={})
        assert exc_info.value.status_code == 403
    finally:
        local_ops_auth.cleanup_local_ops_token(tmp_path)
    assert not (tmp_path / ".local_ops_token").exists()


def test_local_ops_token_ws_server_interval_and_logs_stream(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect
    import local_ops_auth

    assert admin_ops._parse_server_ws_interval({"interval": 0.1}) == 1.0
    assert admin_ops._parse_server_ws_interval({"interval": 99.0}) == 30.0
    assert admin_ops._parse_server_ws_interval({"interval": 1.5}) == 1.5
    assert admin_ops._parse_server_ws_interval({"interval": "bad"}) == admin_ops.SERVER_WS_INTERVAL_SECONDS
    assert admin_ops._parse_server_ws_interval({}) == admin_ops.SERVER_WS_INTERVAL_SECONDS

    app = FastAPI()
    app.include_router(admin_ops.router)
    client = TestClient(app)

    tok = local_ops_auth.init_local_ops_token(tmp_path)
    try:
        with client.websocket_connect("/api/admin/server/ws") as ws:
            ws.send_json({"type": "auth", "local_token": tok, "interval": 1.5})
            assert ws.receive_json()["type"] == "auth_ok"
            status_msg = ws.receive_json()
            assert status_msg["type"] == "status"
            assert "services" in status_msg["data"]

        with client.websocket_connect("/api/admin/logs/ws") as ws:
            ws.send_json({"type": "auth", "local_token": tok, "after": 0, "limit": 10})
            assert ws.receive_json()["type"] == "auth_ok"
            assert ws.receive_json()["type"] == "snapshot"

        # Proxy header on WS handshake is rejected cleanly with 4403
        with client.websocket_connect("/api/admin/server/ws", headers={"CF-Connecting-IP": "1.2.3.4"}) as ws:
            ws.send_json({"type": "auth", "local_token": tok})
            err = ws.receive_json()
            assert err["type"] == "error" and err["code"] == "forbidden"
            with pytest.raises(WebSocketDisconnect) as exc_info:
                ws.receive_json()
            assert exc_info.value.code == admin_ops.WS_CLOSE_FORBIDDEN
    finally:
        local_ops_auth.cleanup_local_ops_token(tmp_path)


def test_server_status_includes_parsed_services(api, monkeypatch):
    client, _ = api

    class _FakeProc:
        stdout = (
            "etymos-api      RUNNING   pid 3900, uptime 15:56:12\n"
            "cloudflared     RUNNING   pid 3901, uptime 15:56:12\n"
            "etymos-deploy   STOPPED   Not started\n"
        )
        stderr = ""

    monkeypatch.setattr(admin_ops, "_supervised", lambda: True)
    monkeypatch.setattr(admin_ops.subprocess, "run", lambda *a, **kw: _FakeProc())
    body = client.get("/api/admin/server").json()
    assert len(body["services"]) == 3
    assert body["services"][0]["name"] == "etymos-api"
    assert body["services"][0]["state"] == "RUNNING"
    assert body["services"][0]["pid"] == 3900
    assert body["services"][2]["state"] == "STOPPED"


def test_service_actions_allowlist_active_check_guard_and_cloudflared_defer(api, monkeypatch):
    client, _ = api
    monkeypatch.setattr(admin_ops, "_supervised", lambda: True)
    deferred: list[tuple[str, str]] = []
    direct: list[tuple[str, str]] = []
    monkeypatch.setattr(admin_ops, "_deferred_service_action", lambda v, s: deferred.append((v, s)) or None)
    monkeypatch.setattr(admin_ops, "_run_service_action", lambda v, s: direct.append((v, s)) or f"{s}: {v} ok")
    monkeypatch.setattr(admin_ops, "record_admin_action", lambda *a, **kw: None)

    # Validation errors
    assert client.post("/api/admin/server/actions/restart-service", json={}).status_code == 422
    assert client.post("/api/admin/server/actions/restart-service", json={"service": "bash"}).status_code == 422

    # Active-check 409 guard on etymos-api
    monkeypatch.setattr(admin_ops, "active_count", lambda: 3)
    refused = client.post("/api/admin/server/actions/stop-service", json={"service": "etymos-api"})
    assert refused.status_code == 409 and "3 check(s)" in refused.json()["detail"]
    assert deferred == []

    forced = client.post("/api/admin/server/actions/stop-service", json={"service": "etymos-api", "force": True})
    assert forced.status_code == 200 and forced.json()["lost_checks"] == 3
    assert ("stop", "etymos-api") in deferred

    # cloudflared restart/stop is deferred so tunnel flushes HTTP response first
    tunnel_res = client.post("/api/admin/server/actions/restart-service", json={"service": "cloudflared"})
    assert tunnel_res.status_code == 200 and tunnel_res.json()["deferred"] is True
    assert ("restart", "cloudflared") in deferred

    # etymos-deploy runs synchronously via _run_service_action
    dep_res = client.post("/api/admin/server/actions/restart-service", json={"service": "etymos-deploy"})
    assert dep_res.status_code == 200
    assert ("restart", "etymos-deploy") in direct


def test_record_admin_action_handles_local_tui_sentinel(monkeypatch):
    fake = _FakeRpcClient()
    monkeypatch.setattr(admin_log, "get_client", lambda: fake)
    admin_log.record_admin_action("local-tui", "server.restart_api", target_table="server", metadata={"force": False})
    [(rpc_name, params)] = fake.calls
    assert rpc_name == "log_admin_action"
    assert params["p_actor_id"] is None
    assert params["p_summary"] == "local-tui"
    assert params["p_metadata"]["channel"] == "local-tui"
