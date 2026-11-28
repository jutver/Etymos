"""Unit tests for Etymos TUI models, sanitizer, tailer, supervisor, auth, and providers."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path

import httpx
import pytest

from tui.__main__ import build_parser, main as tui_main, resolve_mode_and_url
from tui.auth import AuthError, RemoteAuthManager
from tui.log_tailer import LocalLogFileTailer, parse_log_file_line
from tui.models import (
    ActionRequest,
    LogEntry,
    LogFilterState,
    LogStore,
    ManagedServiceInfo,
    ServerSnapshot,
    compute_breakpoint,
    merge_local_and_api_snapshot,
    parse_search_query,
)
from tui.providers.local import LocalDashboardProvider
from tui.providers.remote import RemoteDashboardProvider
from tui.sanitize import mask_email, sanitize_log_text, threshold_level
from tui.supervisor_ctl import LocalSupervisorController, parse_supervisor_status


def test_sanitize_log_text_strips_ansi_osc_controls_and_preserves_brackets():
    dirty = "\x1b[31mERROR\x1b[0m \x1b]0;pwn\x07 [job_1a2b3c4d] val\x00ue\tindented"
    clean = sanitize_log_text(dirty, preserve_newlines=False)
    assert "\x1b" not in clean
    assert "\x00" not in clean
    assert "\x07" not in clean
    assert "[job_1a2b3c4d]" in clean
    assert "    indented" in clean

    raw_bytes = b"bad-\xff-utf8\r\nnext"
    assert "\ufffd" in sanitize_log_text(raw_bytes, preserve_newlines=True)
    assert mask_email("admin@etymos.site") == "a***@etymos.site"
    assert threshold_level(50.0) == "normal"
    assert threshold_level(76.0) == "warning"
    assert threshold_level(91.0) == "critical"


def test_log_store_caps_at_3000_deduplicates_and_filters():
    store = LogStore(capacity=3000)
    for i in range(1, 3501):
        store.append(
            LogEntry(
                key=f"live:{i}",
                seq=i,
                level="WARNING" if i % 10 == 0 else "INFO",
                levelno=logging.WARNING if i % 10 == 0 else logging.INFO,
                logger="api.jobs",
                message=f"msg #{i}",
                job="job_111122223333" if i == 3499 else None,
                request="reqabcd1" if i == 3498 else None,
                user="uuuu1111-2222" if i == 3497 else None,
            )
        )
    assert len(store) == 3000
    assert store.dropped_count == 500
    assert store.append(LogEntry(key="live:3500", seq=3500, message="dup")) is False

    warn_only = store.filtered(LogFilterState(min_level="WARNING"))
    assert len(warn_only) == 300
    assert [e.seq for e in store.filtered(LogFilterState(job="job_1111"))] == [3499]
    assert [e.seq for e in store.filtered(LogFilterState(request="reqabcd1"))] == [3498]
    assert [e.seq for e in store.filtered(LogFilterState(user_id="uuuu1111"))] == [3497]

    free_q, tags = parse_search_query("timeout job:job_abcd req:r99 user:u123")
    assert free_q == "timeout"
    assert tags == {"job": "job_abcd", "request": "r99", "user_id": "u123"}


def test_breakpoint_and_snapshot_merge_precedence():
    assert compute_breakpoint(50, 24) == "too_small"
    assert compute_breakpoint(80, 12) == "too_small"
    assert compute_breakpoint(80, 24) == "narrow"
    assert compute_breakpoint(120, 36) == "medium"
    assert compute_breakpoint(148, 40) == "wide"

    local = ServerSnapshot(mode="local")
    local.machine.host = "gpu-host-01"
    local.gpu.available = True
    local.gpu.name = "RTX 3060"
    local.gpu.total_gb = 12.0
    local.gpu.free_gb = 11.5
    local.services = [ManagedServiceInfo(name="etymos-api", state="STOPPED")]

    api_payload = {
        "checked_at": "2026-11-28T07:00:00Z",
        "process": {"pid": 3900, "uptime": "1h", "uptime_seconds": 3600, "threads": 5, "log_level": "INFO", "supervised": True},
        "host": {"name": "api-container", "cpus": 16, "load": [1.1, 1.2, 1.3]},
        "memory": {"rss_mb": 740, "peak_mb": 780, "system_total_mb": 65536, "system_available_mb": 50000},
        "gpu": {"available": True, "allocated_gb": 2.1, "peak_gb": 3.0, "queue": {"slots": 2, "running": 1, "waiting": 0}, "models": [{"name": "bge-m3", "size_gb": 2.1, "in_use": 1}]},
        "background": {"notifications": True, "support_inbox": True},
        "jobs": {"active": [], "recent": [], "counts": {"completed": 4, "failed": 1}},
    }
    online = merge_local_and_api_snapshot(local, api_payload, api_online=True)
    assert online.api.online and online.api.pid == 3900
    assert online.machine.host == "gpu-host-01"
    assert online.gpu.name == "RTX 3060"
    assert online.gpu.allocated_gb == 2.1 and online.gpu.queue.running == 1
    assert online.background.checks_since_start == 5 and online.background.failed_since_start == 1

    offline = merge_local_and_api_snapshot(local, None, api_online=False)
    assert not offline.api.online
    assert offline.machine.api_rss_mb is None
    assert offline.gpu.name == "RTX 3060" and offline.services[0].state == "STOPPED"


def test_log_file_tailer_handles_appends_truncation_and_rotation(tmp_path):
    log_file = tmp_path / "api.err.log"
    log_file.write_text(
        "2026-11-28 10:00:00.123 +0700 INFO  [job_12345678] jobs: First line\n"
        "2026-11-28 10:00:01.000 +0700 ERROR [r:abc123 u:user9999] api: Boom\n",
        encoding="utf-8",
    )
    tailer = LocalLogFileTailer(tmp_path, initial_lines=50)
    entries, _ = tailer.read_initial("api")
    assert len(entries) == 2
    assert entries[0].job == "job_12345678"
    assert entries[1].level == "ERROR" and entries[1].request == "abc123" and entries[1].user == "user9999"

    with log_file.open("a", encoding="utf-8") as fh:
        fh.write("2026-11-28 10:00:02.000 +0700 WARNING main: Appended warn\n")
    appended, reset = tailer.poll_appends("api")
    assert not reset and len(appended) == 1 and appended[0].level == "WARNING"

    # Rotation resets cleanly
    rotated = tmp_path / "api.err.log.1"
    log_file.rename(rotated)
    log_file.write_text("2026-11-28 10:01:00 New file\n", encoding="utf-8")
    rot_entries, reset = tailer.poll_appends("api")
    assert reset is True and len(rot_entries) == 1 and "New file" in rot_entries[0].message

    parsed_unstructured = parse_log_file_line("plain output line", source="deploy", line_no=1)
    assert parsed_unstructured.level == "RAW"


def test_supervisor_parser_and_offline_controller(tmp_path):
    parsed = parse_supervisor_status(
        "etymos-api      RUNNING   pid 3900, uptime 15:56:12\n"
        "cloudflared     FATAL     Exited too quickly\n"
    )
    assert len(parsed) == 2 and parsed[0].pid == 3900 and parsed[1].state == "FATAL"

    ctl_bin = tmp_path / "supervisorctl"
    conf = tmp_path / "supervisord.conf"
    ctl_bin.write_text("#!/bin/sh\necho 'etymos-api: stopped'\n", encoding="utf-8")
    ctl_bin.chmod(0o755)
    conf.write_text("[supervisord]\n", encoding="utf-8")

    ctl = LocalSupervisorController(supervisorctl=ctl_bin, conf=conf)
    ok, msg = ctl.control_service("stop", "etymos-api")
    assert ok and "stopped" in msg
    with pytest.raises(ValueError):
        ctl.control_service("restart", "not-allowed")  # type: ignore[arg-type]

    provider = LocalDashboardProvider(backend_dir=tmp_path, log_dir=tmp_path, supervisor=ctl)
    outcome = asyncio.run(provider.execute_action(ActionRequest(action="stop-service", service="etymos-api")))
    assert outcome.ok and "stopped" in outcome.summary


def _make_fake_jwt(claims: dict) -> str:
    import base64
    hdr = base64.urlsafe_b64encode(b'{"alg":"HS256","typ":"JWT"}').decode().rstrip("=")
    body = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"{hdr}.{body}.sig"


def test_remote_auth_mfa_session_cache_and_cli(tmp_path, monkeypatch):
    aal1_jwt = _make_fake_jwt({"sub": "u-1", "email": "admin@etymos.site", "aal": "aal1", "exp": time.time() + 3600})
    aal2_jwt = _make_fake_jwt({"sub": "u-1", "email": "admin@etymos.site", "aal": "aal2", "exp": time.time() + 3600})

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/auth/v1/token"):
            return httpx.Response(200, json={"access_token": aal1_jwt, "refresh_token": "ref-1"})
        if request.url.path.endswith("/auth/v1/factors"):
            return httpx.Response(200, json=[{"id": "fac-1", "factor_type": "totp", "status": "verified"}])
        if request.url.path.endswith("/challenge"):
            return httpx.Response(200, json={"id": "chal-1"})
        if request.url.path.endswith("/verify"):
            return httpx.Response(200, json={"access_token": aal2_jwt, "refresh_token": "ref-2"})
        return httpx.Response(404)

    session_file = tmp_path / "tui_session.json"
    mgr = RemoteAuthManager(
        session_path=session_file,
        http_client_factory=lambda: httpx.Client(transport=httpx.MockTransport(handler)),
    )
    sess = mgr.interactive_login(
        api_url="https://api.etymos.site",
        supabase_url="https://sb.example.co",
        supabase_anon_key="anon",
        email="admin@etymos.site",
        password="secret",
        totp_code="123456",
    )
    assert sess.access_token == aal2_jwt
    assert (session_file.stat().st_mode & 0o777) == 0o600
    assert mgr.load_cached_session("https://api.etymos.site") is not None

    with pytest.raises(AuthError):
        mgr.validate_aal2(aal1_jwt)

    resolved = mgr.resolve_token(api_url="https://api.etymos.site", explicit_token=aal2_jwt)
    assert resolved.access_token == aal2_jwt
    assert mgr.clear_cached_session() is True
    assert not session_file.exists()

    # CLI flags verification
    args = build_parser().parse_args(["--remote", "https://api.etymos.site", "--refresh", "2.0", "--log-source", "deploy"])
    mode, url = resolve_mode_and_url(args)
    assert mode == "remote" and url == "https://api.etymos.site"

    monkeypatch.setenv("HOME", str(tmp_path))
    assert tui_main(["--logout"]) == 0


def test_remote_provider_rejects_4401_and_returns_409_conflict(monkeypatch):
    from tui.models import RemoteSessionCache
    from tui.providers.base import AuthErrorEvent, ConnectionEvent

    sess = RemoteSessionCache(
        api_url="https://api.etymos.site",
        supabase_url="https://sb.example.co",
        access_token=_make_fake_jwt({"sub": "u-1", "aal": "aal2", "exp": time.time() + 3600}),
        refresh_token="",
        expires_at=time.time() + 3600,
    )
    provider = RemoteDashboardProvider(api_url="https://api.etymos.site", session=sess)
    events = []
    provider._emit = events.append

    # Simulate 409 conflict on active checks
    class _MockAsyncClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, *a, **kw):
            return httpx.Response(409, json={"detail": "2 check(s) are running and would be lost."})

    monkeypatch.setattr("tui.providers.remote.httpx.AsyncClient", _MockAsyncClient)
    outcome = asyncio.run(provider.execute_action(ActionRequest(action="restart-service", service="etymos-api")))
    assert not outcome.ok and outcome.status_code == 409 and outcome.lost_checks == 2

    # Simulate fatal WS error message handling
    provider._set_connection("auth_required", "Session expired (4401).")
    provider._emit_safe(AuthErrorEvent("Session expired (4401)."))
    assert any(isinstance(e, ConnectionEvent) and e.state == "auth_required" for e in events)
    assert any(isinstance(e, AuthErrorEvent) for e in events)
