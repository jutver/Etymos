"""Tests for opt-in remote command execution (`WS /api/admin/server/exec/ws`), $SV, safety, and audit."""
from __future__ import annotations

import asyncio
import subprocess
import time
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import admin_log
import admin_ops
import remote_exec
from auth import AuthedUser, verify_supabase_jwt
from tui.models import CommandRequest
from tui.providers.base import CommandDoneEvent, CommandOutputEvent, CommandStartedEvent
from tui.providers.local import LocalDashboardProvider
from tui.supervisor_ctl import LocalSupervisorController

ADMIN = AuthedUser(user_id="aaaaaaaa-0000-0000-0000-000000000001", email="admin@etymos.site", role="admin", is_admin=True)
USER = AuthedUser(user_id="bbbbbbbb-0000-0000-0000-000000000002", email="user@etymos.site", role="user", is_admin=False)


def _setup_test_api(monkeypatch, tmp_path: Path, *, exp_offset: float = 3600.0):
    app = FastAPI()
    app.include_router(admin_ops.router)
    app.dependency_overrides[verify_supabase_jwt] = lambda: ADMIN

    audits: list[dict] = []

    def _fake_audit(admin_id, action, **kwargs):
        audits.append({"admin_id": admin_id, "action": action, **kwargs})

    monkeypatch.setattr(admin_log, "record_admin_action", _fake_audit)
    monkeypatch.setattr(admin_ops, "record_admin_action", _fake_audit)
    monkeypatch.setattr(admin_log, "get_client", lambda: None)

    def _fake_verify_jwt(token: str):
        if token == "bad-token":
            raise HTTPException(status_code=401, detail="Invalid token.")
        if token == "user-token":
            return USER, time.time() + exp_offset
        if token == "non-mfa-token":
            raise HTTPException(status_code=403, detail="Admin MFA (aal2) required.")
        if token == "short-lived-token":
            return ADMIN, time.time() + 0.15
        return ADMIN, time.time() + exp_offset

    monkeypatch.setattr(admin_ops, "verify_jwt_token", _fake_verify_jwt)
    return TestClient(app), audits


def test_remote_exec_disabled_by_default_and_audited(monkeypatch, tmp_path):
    monkeypatch.delenv("ADMIN_REMOTE_EXEC_ENABLED", raising=False)
    client, audits = _setup_test_api(monkeypatch, tmp_path)

    status = client.get("/api/admin/server").json()
    assert status["remote_exec"]["enabled"] is False
    assert "default_timeout_seconds" in status["remote_exec"]

    with client.websocket_connect("/api/admin/server/exec/ws") as ws:
        ws.send_json({"type": "auth", "token": "admin-aal2"})
        auth_ok = ws.receive_json()
        assert auth_ok["type"] == "auth_ok"
        assert auth_ok["remote_exec"]["enabled"] is False

        ws.send_json({"type": "run", "run_id": "cmd_disabled01", "command": "echo hi"})
        done = ws.receive_json()
        assert done["type"] == "done"
        assert done["run_id"] == "cmd_disabled01"
        assert done["status"] == "disabled"
        assert done["exit_code"] is None
        assert "ADMIN_REMOTE_EXEC_ENABLED=true" in (done["error"] or "")

    assert any(a["action"] == "server.exec_denied" and a["target_id"] == "cmd_disabled01" for a in audits)


def test_exec_ws_rejects_unauth_non_admin_and_expired_jwt(monkeypatch, tmp_path):
    monkeypatch.setenv("ADMIN_REMOTE_EXEC_ENABLED", "true")
    client, _ = _setup_test_api(monkeypatch, tmp_path)

    # Non-admin user -> 4403
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect("/api/admin/server/exec/ws") as ws:
            ws.send_json({"type": "auth", "token": "user-token"})
            err = ws.receive_json()
            assert err["type"] == "error"
            ws.receive_json()
    assert exc_info.value.code == 4403

    # Non-MFA / invalid token -> 4401
    with pytest.raises(WebSocketDisconnect) as exc_info2:
        with client.websocket_connect("/api/admin/server/exec/ws") as ws:
            ws.send_json({"type": "auth", "token": "bad-token"})
            err = ws.receive_json()
            assert err["type"] == "error"
            ws.receive_json()
    assert exc_info2.value.code == 4401

    # Expired mid-session before run -> closes 4401
    with pytest.raises(WebSocketDisconnect) as exc_info3:
        with client.websocket_connect("/api/admin/server/exec/ws") as ws:
            ws.send_json({"type": "auth", "token": "short-lived-token"})
            assert ws.receive_json()["type"] == "auth_ok"
            time.sleep(0.25)
            ws.send_json({"type": "run", "run_id": "cmd_exp01", "command": "echo hi"})
            err = ws.receive_json()
            assert err["type"] == "error" and err["code"] == "unauthorized"
            ws.receive_json()
    assert exc_info3.value.code == 4401


def test_resolve_sv_and_safe_env_strips_secrets(monkeypatch, tmp_path):
    # Inject fake production secrets to ensure NONE leak to child shell
    secret_vars = {
        "SUPABASE_SERVICE_ROLE_KEY": "sb-service-secret",
        "SUPABASE_JWT_SECRET": "jwt-super-secret",
        "SMTP_PASSWORD": "smtp-secret-password",
        "GEMINI_API_KEY": "gem-secret",
        "PAYOS_CHECKSUM_KEY": "payos-secret",
        "GITHUB_TOKEN": "ghp_secret_123",
    }
    for k, v in secret_vars.items():
        monkeypatch.setenv(k, v)

    # 1. Clean paths (no spaces) -> SV without inner quotes (matches docs/SERVER_OPERATIONS.md)
    clean_dir = tmp_path / "clean_backend"
    (clean_dir / ".venv" / "bin").mkdir(parents=True)
    sv_bin = clean_dir / ".venv" / "bin" / "supervisorctl"
    sv_bin.write_text("#!/usr/bin/env bash\necho \"args:$*\"\n", encoding="utf-8")
    sv_bin.chmod(0o755)
    conf = clean_dir / "supervisord.conf"
    conf.write_text("[supervisord]\n", encoding="utf-8")

    monkeypatch.delenv("SUPERVISORCTL", raising=False)
    monkeypatch.delenv("SUPERVISOR_CONF", raising=False)
    env_clean = remote_exec.build_safe_exec_env(backend_dir=clean_dir, log_dir=clean_dir / "logs")
    for k in secret_vars:
        assert k not in env_clean
    assert env_clean["SV"] == f"{sv_bin} -c {conf}"
    proc = subprocess.run(["/bin/bash", "-c", "$SV status"], env=env_clean, capture_output=True, text=True)
    assert proc.returncode == 0
    assert f"-c {conf} status" in proc.stdout

    # 2. Path with whitespace -> wrapper script so `$SV status` still executes cleanly
    spaced_dir = tmp_path / "space backend"
    (spaced_dir / ".venv" / "bin").mkdir(parents=True)
    sv_bin2 = spaced_dir / ".venv" / "bin" / "supervisorctl"
    sv_bin2.write_text("#!/usr/bin/env bash\necho \"SPACED:$*\"\n", encoding="utf-8")
    sv_bin2.chmod(0o755)
    conf2 = spaced_dir / "supervisord.conf"
    conf2.write_text("[supervisord]\n", encoding="utf-8")

    env_spaced = remote_exec.build_safe_exec_env(backend_dir=spaced_dir, log_dir=spaced_dir / "logs")
    proc2 = subprocess.run(["/bin/bash", "-c", "$SV status"], env=env_spaced, capture_output=True, text=True)
    assert proc2.returncode == 0
    assert "SPACED:-c " in proc2.stdout and "status" in proc2.stdout


def test_exec_ws_streams_stdout_stderr_sv_and_audits_redacted(monkeypatch, tmp_path):
    monkeypatch.setenv("ADMIN_REMOTE_EXEC_ENABLED", "true")
    sv_bin = tmp_path / "fake_supervisorctl"
    sv_bin.write_text("#!/usr/bin/env bash\necho \"etymos-api RUNNING ($*)\"\n", encoding="utf-8")
    sv_bin.chmod(0o755)
    conf = tmp_path / "supervisord.conf"
    conf.write_text("[supervisord]\n", encoding="utf-8")
    monkeypatch.setenv("SUPERVISORCTL", str(sv_bin))
    monkeypatch.setenv("SUPERVISOR_CONF", str(conf))

    client, audits = _setup_test_api(monkeypatch, tmp_path)

    with client.websocket_connect("/api/admin/server/exec/ws") as ws:
        ws.send_json({"type": "auth", "token": "admin-aal2"})
        assert ws.receive_json()["type"] == "auth_ok"

        # Verify $SV status and redacted secrets on audit
        cmd = "PASSWORD=topsecretvalue $SV status && echo err_line >&2"
        ws.send_json({"type": "run", "run_id": "cmd_sv01", "command": cmd, "timeout": 15})
        frames = []
        while True:
            frame = ws.receive_json()
            frames.append(frame)
            if frame["type"] == "done":
                break

    assert frames[0]["type"] == "started" and frames[0]["run_id"] == "cmd_sv01"
    out_stdout = "".join(f["data"] for f in frames if f["type"] == "output" and f["stream"] == "stdout")
    out_stderr = "".join(f["data"] for f in frames if f["type"] == "output" and f["stream"] == "stderr")
    assert "etymos-api RUNNING" in out_stdout
    assert "err_line" in out_stderr
    done = frames[-1]
    assert done["status"] == "completed" and done["exit_code"] == 0 and done["duration_ms"] >= 0

    exec_audits = [a for a in audits if a["action"] == "server.exec" and a["target_id"] == "cmd_sv01"]
    assert len(exec_audits) == 1
    summary = exec_audits[0]["summary"]
    assert "topsecretvalue" not in summary
    assert "[REDACTED]" in summary

    # Direct redaction checks
    red = remote_exec.redact_command_for_audit(
        "curl -H 'Authorization: Bearer tok_abc123' https://u:pass123@x.com TOKEN=abc"
    )
    assert "tok_abc123" not in red and "pass123" not in red and "=abc" not in red


def test_exec_ws_cancel_timeout_concurrent_and_output_cap(monkeypatch, tmp_path):
    monkeypatch.setenv("ADMIN_REMOTE_EXEC_ENABLED", "true")
    monkeypatch.setenv("ADMIN_REMOTE_EXEC_MAX_OUTPUT_BYTES", "4096")
    client, _ = _setup_test_api(monkeypatch, tmp_path)

    with client.websocket_connect("/api/admin/server/exec/ws") as ws:
        ws.send_json({"type": "auth", "token": "admin-aal2"})
        assert ws.receive_json()["type"] == "auth_ok"

        # 1. Empty / invalid command rejected cleanly
        ws.send_json({"type": "run", "run_id": "cmd_empty", "command": "   "})
        bad = ws.receive_json()
        assert bad["type"] == "done" and bad["status"] == "failed"

        # 2. Long running + concurrent run rejected + cancel within 2s
        ws.send_json({"type": "run", "run_id": "cmd_sleep", "command": "sleep 20"})
        started = ws.receive_json()
        assert started["type"] == "started"

        ws.send_json({"type": "run", "run_id": "cmd_concurrent", "command": "echo two"})
        conc = ws.receive_json()
        assert conc["type"] == "done" and conc["run_id"] == "cmd_concurrent" and conc["status"] == "failed"

        t0 = time.monotonic()
        ws.send_json({"type": "cancel", "run_id": "cmd_sleep"})
        while True:
            frame = ws.receive_json()
            if frame["type"] == "done" and frame["run_id"] == "cmd_sleep":
                assert frame["status"] == "cancelled"
                break
        assert (time.monotonic() - t0) < 2.5

        # 3. Enforced timeout (1s)
        ws.send_json({"type": "run", "run_id": "cmd_to", "command": "sleep 10", "timeout": 1})
        while True:
            frame = ws.receive_json()
            if frame["type"] == "done" and frame["run_id"] == "cmd_to":
                assert frame["status"] == "timed_out"
                break

        # 4. Output cap truncation cleanly sets truncated=True
        ws.send_json(
            {
                "type": "run",
                "run_id": "cmd_big",
                "command": "python3 -c \"print('A' * 15000)\"",
                "timeout": 10,
            }
        )
        chunks = []
        while True:
            frame = ws.receive_json()
            if frame["type"] == "output":
                chunks.append(frame["data"])
            elif frame["type"] == "done" and frame["run_id"] == "cmd_big":
                assert frame["truncated"] is True
                break
        assert len("".join(chunks).encode("utf-8")) <= 4096


def test_local_provider_runs_and_cancels_commands_offline(monkeypatch, tmp_path):
    sv_bin = tmp_path / "supervisorctl"
    sv_bin.write_text("#!/usr/bin/env bash\necho 'offline-local-sv ok'\n", encoding="utf-8")
    sv_bin.chmod(0o755)
    conf = tmp_path / "supervisord.conf"
    conf.write_text("[supervisord]\n", encoding="utf-8")
    monkeypatch.setenv("SUPERVISORCTL", str(sv_bin))
    monkeypatch.setenv("SUPERVISOR_CONF", str(conf))

    ctl = LocalSupervisorController(supervisorctl=sv_bin, conf=conf)
    provider = LocalDashboardProvider(backend_dir=tmp_path, log_dir=tmp_path, supervisor=ctl)
    events = []
    provider._emit = events.append

    asyncio.run(provider.run_command(CommandRequest(run_id="cmd_loc1", command="$SV status")))
    assert any(isinstance(e, CommandStartedEvent) and e.run_id == "cmd_loc1" for e in events)
    out = "".join(e.data for e in events if isinstance(e, CommandOutputEvent))
    assert "offline-local-sv ok" in out
    assert any(isinstance(e, CommandDoneEvent) and e.status == "completed" and e.exit_code == 0 for e in events)
