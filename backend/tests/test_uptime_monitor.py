"""
Unit tests for backend/api/uptime_monitor.py and server down/recovery email templates.
Uses pure in-memory fakes; no network calls or real emails are sent.
"""
from __future__ import annotations

import io
import json
import logging
import socket
import urllib.error
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import pytest

import email_templates
import mailer
import uptime_monitor


class _FakeResponse:
    def __init__(self, status: int, body: str):
        self.status = status
        self._buf = io.BytesIO(body.encode("utf-8"))

    def read(self, n: int = -1) -> bytes:
        return self._buf.read(n)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class _InMemoryMonitorStore:
    def __init__(self, initial_state: Optional[dict[str, Any]] = None, admins: Optional[list[str]] = None):
        self.states: dict[str, dict[str, Any]] = {}
        if initial_state:
            self.states[initial_state["service_name"]] = dict(initial_state)
        self.admins = list(admins or ["admin1@etymos.site", "admin2@etymos.site"])
        self.notification_log: dict[tuple[str, str], dict[str, Any]] = {}
        self.admin_shutdown_recent = False

    def get_state(self, service_name: str) -> Optional[dict[str, Any]]:
        row = self.states.get(service_name)
        return dict(row) if row else None

    def upsert_state(self, row: dict[str, Any]) -> dict[str, Any]:
        self.states[row["service_name"]] = dict(row)
        return dict(row)

    def list_admin_emails(self) -> list[str]:
        return sorted(self.admins)

    def claim_notification(self, kind: str, ref: str, recipient: str) -> bool:
        key = (kind, ref)
        if key in self.notification_log:
            return False
        self.notification_log[key] = {"kind": kind, "ref": ref, "recipient": recipient, "status": "sending"}
        return True

    def mark_notification_sent(self, kind: str, ref: str, sent_at: str) -> None:
        key = (kind, ref)
        if key in self.notification_log:
            self.notification_log[key]["status"] = "sent"
            self.notification_log[key]["sent_at"] = sent_at

    def release_notification_claim(self, kind: str, ref: str) -> None:
        self.notification_log.pop((kind, ref), None)

    def recent_admin_shutdown(self, since_iso: str) -> bool:
        return self.admin_shutdown_recent


@pytest.fixture
def configured_smtp(monkeypatch):
    monkeypatch.setenv("SMTP_HOST", "mail.etymos.site")
    monkeypatch.setenv("SMTP_USER", "noreply@etymos.site")
    monkeypatch.setenv("SMTP_PASSWORD", "super-secret-smtp-pass")
    monkeypatch.delenv("ADMIN_ALERT_EMAILS", raising=False)
    monkeypatch.setenv("ADMIN_APP_URL", "https://admin.etymos.site")


def test_probe_health_symptom_mapping_and_error_bound():
    ok = uptime_monitor.probe_health(
        "https://api.etymos.site/api/health",
        opener=lambda _r, _t: _FakeResponse(200, json.dumps({"status": "ok"})),
    )
    assert ok == uptime_monitor.ProbeResult(healthy=True, http_status=200, error=None)

    def err_530(_r, _t):
        raise urllib.error.HTTPError("https://x", 530, "Origin Error", {}, io.BytesIO(b"Cloudflare error 1033"))

    cf_off = uptime_monitor.probe_health("https://api.etymos.site/api/health", opener=err_530)
    assert cf_off.healthy is False and cf_off.http_status == 530
    assert "1033" in (cf_off.error or "")

    def err_502(_r, _t):
        raise urllib.error.HTTPError("https://x", 502, "Bad Gateway", {}, io.BytesIO(b""))

    api_down = uptime_monitor.probe_health("https://api.etymos.site/api/health", opener=err_502)
    assert api_down.healthy is False and api_down.http_status == 502
    assert "502" in (api_down.error or "")

    def err_timeout(_r, _t):
        raise socket.timeout("timed out")

    to_res = uptime_monitor.probe_health("https://api.etymos.site/api/health", timeout_seconds=10.0, opener=err_timeout)
    assert to_res.healthy is False and "timed out" in (to_res.error or "").lower()

    def err_huge(_r, _t):
        raise urllib.error.URLError("x" * 1200)

    huge = uptime_monitor.probe_health("https://api.etymos.site/api/health", opener=err_huge)
    assert len(huge.error or "") <= 500


def test_email_templates_render_with_admin_status_url():
    down = email_templates.server_down_email(
        service_name="etymos-api",
        health_url="https://api.etymos.site/api/health",
        detected_at="27 Nov 2026, 20:15 (Vietnam time)",
        symptom="Cloudflare Tunnel offline (HTTP 530 / error 1033)",
        consecutive_failures=3,
        flapping_note="Flapping detected.",
        admin_url="https://admin.etymos.site/",
    )
    assert down.subject == "[ALERT] Etymos backend server is DOWN (etymos-api)"
    assert down.button_url == "https://admin.etymos.site/logs/server/status"
    html_down = email_templates.render_email(down)
    assert "Backend server is down" in html_down
    assert "1033" in html_down

    rec = email_templates.server_recovered_email(
        service_name="etymos-api",
        health_url="https://api.etymos.site/api/health",
        recovered_at="27 Nov 2026, 20:20 (Vietnam time)",
        downtime_duration="5 minutes",
        down_since="27 Nov 2026, 20:15 (Vietnam time)",
        admin_url="https://admin.etymos.site",
    )
    assert rec.subject == "[RECOVERED] Etymos backend server is back online (etymos-api)"
    assert rec.button_url == "https://admin.etymos.site/logs/server/status"
    text_rec = email_templates.render_text(rec)
    assert "5 minutes" in text_rec


def test_brief_restart_under_120s_sends_zero_alerts(configured_smtp):
    t = [datetime(2026, 11, 27, 13, 0, tzinfo=timezone.utc)]
    store = _InMemoryMonitorStore()
    sent: list[tuple[str, str]] = []

    def advance(sec: int) -> None:
        t[0] += timedelta(seconds=sec)

    # Fail #1 (0s) and Fail #2 (35s) -> degraded, no email
    uptime_monitor.run_monitor(
        store=store,
        probe_fn=lambda _u: uptime_monitor.ProbeResult(False, 502, "HTTP 502"),
        send_fn=lambda to, c: sent.append((to, c.subject)),
        now_fn=lambda: t[0],
    )
    advance(35)
    uptime_monitor.run_monitor(
        store=store,
        probe_fn=lambda _u: uptime_monitor.ProbeResult(False, 502, "HTTP 502"),
        send_fn=lambda to, c: sent.append((to, c.subject)),
        now_fn=lambda: t[0],
    )
    assert store.get_state("etymos-api")["status"] == "degraded"
    assert sent == []

    # Recover at 65s -> back to up cleanly, zero orphan recovery emails
    advance(30)
    res = uptime_monitor.run_monitor(
        store=store,
        probe_fn=lambda _u: uptime_monitor.ProbeResult(True, 200, None),
        send_fn=lambda to, c: sent.append((to, c.subject)),
        now_fn=lambda: t[0],
    )
    assert res["status"] == "up"
    assert sent == []


def test_sustained_outage_and_recovery_lifecycle_and_poll_mode(configured_smtp):
    t = [datetime(2026, 11, 27, 13, 0, tzinfo=timezone.utc)]
    store = _InMemoryMonitorStore()
    sent: list[tuple[str, email_templates.EmailContent]] = []

    def fake_sleep(sec: float) -> None:
        t[0] += timedelta(seconds=sec)

    # poll mode fails continuously across confirmation window -> fires exactly 1 Server Down per admin
    res = uptime_monitor.run_monitor(
        store=store,
        mode="poll",
        confirm_failures=3,
        confirm_window_seconds=120,
        confirm_interval_seconds=30,
        probe_fn=lambda _u: uptime_monitor.ProbeResult(False, 530, "Tunnel offline 1033"),
        send_fn=lambda to, c: sent.append((to, c)),
        now_fn=lambda: t[0],
        sleep_fn=fake_sleep,
    )
    assert res["status"] == "down"
    assert res["sent_count"] == 2
    assert {to for to, _ in sent} == {"admin1@etymos.site", "admin2@etymos.site"}
    assert all("DOWN" in c.subject for _, c in sent)

    # Prolonged outage check 30 minutes later must NOT spam duplicate down emails
    t[0] += timedelta(minutes=30)
    res_still_down = uptime_monitor.run_monitor(
        store=store,
        mode="dispatch",
        probe_fn=lambda _u: uptime_monitor.ProbeResult(False, 530, "Tunnel offline 1033"),
        send_fn=lambda to, c: sent.append((to, c)),
        now_fn=lambda: t[0],
    )
    assert res_still_down["status"] == "down"
    assert res_still_down["sent_count"] == 0
    assert len(sent) == 2

    # Service comes back online after 35 minutes total -> fires exactly 1 Recovery email per admin
    t[0] += timedelta(minutes=3)
    res_up = uptime_monitor.run_monitor(
        store=store,
        mode="dispatch",
        probe_fn=lambda _u: uptime_monitor.ProbeResult(True, 200, None),
        send_fn=lambda to, c: sent.append((to, c)),
        now_fn=lambda: t[0],
    )
    assert res_up["status"] == "up"
    assert res_up["sent_count"] == 2
    assert len(sent) == 4
    rec_mail = sent[2][1]
    assert "back online" in rec_mail.subject.lower()
    assert ("Total downtime", "35 minutes") in rec_mail.details

    # Subsequent healthy check sends 0 emails
    t[0] += timedelta(minutes=1)
    res_steady = uptime_monitor.run_monitor(
        store=store,
        mode="dispatch",
        probe_fn=lambda _u: uptime_monitor.ProbeResult(True, 200, None),
        send_fn=lambda to, c: sent.append((to, c)),
        now_fn=lambda: t[0],
    )
    assert res_steady["sent_count"] == 0 and len(sent) == 4


def test_orphan_recovery_suppressed_if_down_alert_never_sent(configured_smtp):
    now = datetime(2026, 11, 27, 13, 10, tzinfo=timezone.utc)
    store = _InMemoryMonitorStore(
        initial_state={
            **uptime_monitor._initial_state("etymos-api", "https://api.etymos.site/api/health"),
            "status": "down",
            "down_since": (now - timedelta(minutes=5)).isoformat(),
            "current_incident_id": "inc-unalerted",
            "down_alert_sent_at": None,
        }
    )
    sent: list[str] = []
    res = uptime_monitor.run_monitor(
        store=store,
        probe_fn=lambda _u: uptime_monitor.ProbeResult(True, 200, None),
        send_fn=lambda to, _c: sent.append(to),
        now_fn=lambda: now,
    )
    assert res["status"] == "up"
    assert res["sent_count"] == 0
    assert sent == []


def test_recipient_override_and_dry_run_non_mutation(configured_smtp, monkeypatch):
    monkeypatch.setenv("ADMIN_ALERT_EMAILS", "ops@etymos.site, sec@etymos.site, ops@etymos.site")
    store = _InMemoryMonitorStore()
    assert uptime_monitor.resolve_admin_recipients(store) == ["ops@etymos.site", "sec@etymos.site"]

    now = datetime(2026, 11, 27, 13, 0, tzinfo=timezone.utc)
    store.upsert_state(
        {
            **uptime_monitor._initial_state("etymos-api", "https://api.etymos.site/api/health"),
            "status": "degraded",
            "consecutive_failures": 2,
            "first_failure_at": (now - timedelta(seconds=130)).isoformat(),
        }
    )
    sent: list[str] = []
    dry_res = uptime_monitor.run_monitor(
        store=store,
        dry_run=True,
        probe_fn=lambda _u: uptime_monitor.ProbeResult(False, 502, "HTTP 502"),
        send_fn=lambda to, _c: sent.append(to),
        now_fn=lambda: now,
    )
    assert dry_res["actions"] == ["would_send_server_down"]
    assert sent == []
    # DB row stayed untouched in degraded state
    assert store.get_state("etymos-api")["status"] == "degraded"


def test_smtp_partial_failure_retries_only_failed_recipients_on_next_tick(configured_smtp):
    t = [datetime(2026, 11, 27, 13, 5, tzinfo=timezone.utc)]
    store = _InMemoryMonitorStore(
        initial_state={
            **uptime_monitor._initial_state("etymos-api", "https://api.etymos.site/api/health"),
            "status": "degraded",
            "consecutive_failures": 2,
            "first_failure_at": (t[0] - timedelta(seconds=140)).isoformat(),
        },
        admins=["a@etymos.site", "b@etymos.site"],
    )
    deliveries: list[str] = []
    fail_b = [True]

    def flaky_send(to: str, _content: email_templates.EmailContent) -> None:
        if to == "b@etymos.site" and fail_b[0]:
            raise RuntimeError("SMTP temporarily unavailable")
        deliveries.append(to)

    res1 = uptime_monitor.run_monitor(
        store=store,
        probe_fn=lambda _u: uptime_monitor.ProbeResult(False, 502, "HTTP 502"),
        send_fn=flaky_send,
        now_fn=lambda: t[0],
        sleep_fn=lambda _s: None,
    )
    assert res1["sent_count"] == 1 and res1["failed_count"] == 1
    assert deliveries == ["a@etymos.site"]
    assert store.get_state("etymos-api")["down_alert_sent_at"] is None

    # Recover SMTP on next tick -> ONLY b@etymos.site receives Server Down (a@ not duplicated!)
    fail_b[0] = False
    t[0] += timedelta(seconds=30)
    res2 = uptime_monitor.run_monitor(
        store=store,
        probe_fn=lambda _u: uptime_monitor.ProbeResult(False, 502, "HTTP 502"),
        send_fn=flaky_send,
        now_fn=lambda: t[0],
        sleep_fn=lambda _s: None,
    )
    assert res2["sent_count"] == 1 and res2["failed_count"] == 0
    assert deliveries == ["a@etymos.site", "b@etymos.site"]
    assert store.get_state("etymos-api")["down_alert_sent_at"] is not None

    # Test recovery email SMTP failure + next-tick retry while server stays UP
    fail_b[0] = True
    t[0] += timedelta(minutes=2)
    res_rec1 = uptime_monitor.run_monitor(
        store=store,
        probe_fn=lambda _u: uptime_monitor.ProbeResult(True, 200, None),
        send_fn=flaky_send,
        now_fn=lambda: t[0],
        sleep_fn=lambda _s: None,
    )
    assert res_rec1["actions"] == ["retry_pending_recovery"]
    assert store.get_state("etymos-api")["pending_recovery_incident_id"] is not None

    fail_b[0] = False
    t[0] += timedelta(seconds=30)
    res_rec2 = uptime_monitor.run_monitor(
        store=store,
        probe_fn=lambda _u: uptime_monitor.ProbeResult(True, 200, None),
        send_fn=flaky_send,
        now_fn=lambda: t[0],
        sleep_fn=lambda _s: None,
    )
    assert res_rec2["actions"] == ["sent_server_recovered"]
    assert store.get_state("etymos-api")["pending_recovery_incident_id"] is None
    assert deliveries == ["a@etymos.site", "b@etymos.site", "a@etymos.site", "b@etymos.site"]


def test_flapping_protection_cooldown_instability_note_and_window_reset(configured_smtp):
    t = [datetime(2026, 11, 27, 14, 0, tzinfo=timezone.utc)]
    store = _InMemoryMonitorStore(
        initial_state={
            **uptime_monitor._initial_state("etymos-api", "https://api.etymos.site/api/health"),
            "status": "degraded",
            "consecutive_failures": 2,
            "first_failure_at": (t[0] - timedelta(seconds=130)).isoformat(),
            "flapping_window_started_at": (t[0] - timedelta(minutes=10)).isoformat(),
            "flapping_transitions": 3,
            "last_alert_at": (t[0] - timedelta(minutes=2)).isoformat(),
        },
        admins=["admin@etymos.site"],
    )
    sent: list[email_templates.EmailContent] = []

    # 4th alert in window still sends and attaches instability flapping_note
    res1 = uptime_monitor.run_monitor(
        store=store,
        probe_fn=lambda _u: uptime_monitor.ProbeResult(False, 530, "1033"),
        send_fn=lambda _to, c: sent.append(c),
        now_fn=lambda: t[0],
    )
    assert res1["sent_count"] == 1
    assert any(k == "Stability notice" for k, _ in sent[0].details)
    assert store.get_state("etymos-api")["flapping_transitions"] == 4

    # Recovery 2 minutes later is inside 15-min cooldown -> suppressed (no flood!)
    t[0] += timedelta(minutes=2)
    res2 = uptime_monitor.run_monitor(
        store=store,
        probe_fn=lambda _u: uptime_monitor.ProbeResult(True, 200, None),
        send_fn=lambda _to, c: sent.append(c),
        now_fn=lambda: t[0],
    )
    assert res2["actions"] == ["suppressed_flapping"]
    assert len(sent) == 1

    # Once > 30 minutes pass since window start, counter resets cleanly and pending recovery delivers
    t[0] += timedelta(minutes=31)
    res3 = uptime_monitor.run_monitor(
        store=store,
        probe_fn=lambda _u: uptime_monitor.ProbeResult(True, 200, None),
        send_fn=lambda _to, c: sent.append(c),
        now_fn=lambda: t[0],
    )
    assert res3["actions"] == ["sent_server_recovered"]
    assert store.get_state("etymos-api")["flapping_transitions"] == 1
    assert len(sent) == 2


def test_intentional_admin_shutdown_note_and_log_masking(configured_smtp, caplog):
    now = datetime(2026, 11, 27, 15, 0, tzinfo=timezone.utc)
    store = _InMemoryMonitorStore(
        initial_state={
            **uptime_monitor._initial_state("etymos-api", "https://api.etymos.site/api/health"),
            "status": "degraded",
            "consecutive_failures": 2,
            "first_failure_at": (now - timedelta(seconds=130)).isoformat(),
        },
        admins=["secret-operator@etymos.site"],
    )
    store.admin_shutdown_recent = True
    sent: list[email_templates.EmailContent] = []

    with caplog.at_level(logging.INFO, logger="etymos.uptime_monitor"):
        uptime_monitor.run_monitor(
            store=store,
            probe_fn=lambda _u: uptime_monitor.ProbeResult(False, 502, "Backend API unreachable behind tunnel (HTTP 502)"),
            send_fn=lambda _to, c: sent.append(c),
            now_fn=lambda: now,
        )

    assert len(sent) == 1
    issue_val = dict(sent[0].details)["Observed issue"]
    assert "administrator triggered API shutdown" in issue_val
    assert "secret-operator@etymos.site" not in caplog.text
    assert mailer.mask_address("secret-operator@etymos.site") in caplog.text
    assert "super-secret-smtp-pass" not in caplog.text
