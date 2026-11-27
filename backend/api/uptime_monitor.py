"""
uptime_monitor.py
-----------------
External backend availability probe, incident state machine, and SMTP alert
dispatcher using 100% Python standard library plus sibling `mailer` and
`email_templates` modules.

Designed to run outside the GPU host (e.g. GitHub Actions triggered on
state transitions by Supabase pg_cron + pg_net, or on a fallback schedule).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Optional, Protocol

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import email_templates  # noqa: E402
import mailer  # noqa: E402

logger = logging.getLogger("etymos.uptime_monitor")

VN_TZ = timezone(timedelta(hours=7))
DEFAULT_SERVICE_NAME = "etymos-api"
DEFAULT_HEALTH_URL = "https://api.etymos.site/api/health"
MAX_ERROR_LENGTH = 500


def _truncate_error(text: str, limit: int = MAX_ERROR_LENGTH) -> str:
    clean = " ".join((text or "").split())
    if len(clean) <= limit:
        return clean
    return clean[: limit - 3] + "..."


def _parse_ts(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    normalized = value.strip().replace("Z", "+00:00")
    parsed = datetime.fromisoformat(normalized)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def format_vn_datetime(dt: Optional[datetime | str]) -> str:
    parsed = _parse_ts(dt) if isinstance(dt, str) else dt
    if parsed is None:
        return "unknown"
    utc_dt = parsed.astimezone(timezone.utc)
    vn_dt = parsed.astimezone(VN_TZ)
    return f"{vn_dt.strftime('%d %b %Y, %H:%M')} (Vietnam time) / {utc_dt.strftime('%H:%M UTC')}"


def format_duration(seconds: float) -> str:
    total = max(0, int(round(seconds)))
    if total < 60:
        return f"{total} second{'s' if total != 1 else ''}"
    days, rem = divmod(total, 86400)
    hours, rem = divmod(rem, 3600)
    minutes, secs = divmod(rem, 60)
    parts: list[str] = []
    if days:
        parts.append(f"{days} day{'s' if days != 1 else ''}")
    if hours:
        parts.append(f"{hours} hour{'s' if hours != 1 else ''}")
    if minutes:
        parts.append(f"{minutes} minute{'s' if minutes != 1 else ''}")
    if not parts and secs:
        parts.append(f"{secs} second{'s' if secs != 1 else ''}")
    return " ".join(parts) if parts else "0 seconds"


@dataclass
class ProbeResult:
    healthy: bool
    http_status: Optional[int]
    error: Optional[str]


def _classify_unhealthy_http(status_code: int, body: str) -> str:
    if status_code == 530 or "1033" in body:
        return _truncate_error(
            f"Cloudflare Tunnel offline (HTTP {status_code} / error 1033) — supervisord or cloudflared may not be running."
        )
    if status_code in (502, 503, 504):
        return _truncate_error(
            f"Backend API unreachable behind tunnel (HTTP {status_code}) — uvicorn may still be starting or stopped."
        )
    return _truncate_error(f"Unexpected health response (HTTP {status_code}).")


def probe_health(
    health_url: str,
    *,
    timeout_seconds: float = 10.0,
    opener: Optional[Callable[[urllib.request.Request, float], Any]] = None,
) -> ProbeResult:
    """Probes `<health_url>` expecting HTTP 200 and JSON `{\"status\": \"ok\"}`."""
    req = urllib.request.Request(
        health_url,
        headers={
            "Accept": "application/json",
            "User-Agent": "etymos-uptime-monitor/1.0",
        },
        method="GET",
    )

    def _default_open(r: urllib.request.Request, timeout: float) -> Any:
        return urllib.request.urlopen(r, timeout=timeout)

    open_fn = opener or _default_open
    try:
        with open_fn(req, timeout_seconds) as resp:
            status_code = int(getattr(resp, "status", 200))
            raw = resp.read(8192)
            body = raw.decode("utf-8", errors="replace") if isinstance(raw, (bytes, bytearray)) else str(raw)
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            raw = exc.read(4096)
            body = raw.decode("utf-8", errors="replace") if isinstance(raw, (bytes, bytearray)) else str(raw)
        except Exception:
            body = ""
        return ProbeResult(
            healthy=False,
            http_status=int(exc.code),
            error=_classify_unhealthy_http(int(exc.code), body),
        )
    except (TimeoutError, socket.timeout):
        return ProbeResult(
            healthy=False,
            http_status=None,
            error=_truncate_error(f"Health check timed out after {int(timeout_seconds)}s."),
        )
    except urllib.error.URLError as exc:
        reason = exc.reason
        if isinstance(reason, (TimeoutError, socket.timeout)):
            return ProbeResult(
                healthy=False,
                http_status=None,
                error=_truncate_error(f"Health check timed out after {int(timeout_seconds)}s."),
            )
        return ProbeResult(
            healthy=False,
            http_status=None,
            error=_truncate_error(f"Connection failed: {reason}."),
        )
    except Exception as exc:
        return ProbeResult(
            healthy=False,
            http_status=None,
            error=_truncate_error(f"Connection failed: {exc}."),
        )

    if status_code != 200:
        return ProbeResult(
            healthy=False,
            http_status=status_code,
            error=_classify_unhealthy_http(status_code, body),
        )

    try:
        payload = json.loads(body)
    except Exception:
        return ProbeResult(
            healthy=False,
            http_status=status_code,
            error=_truncate_error(f"Unexpected health payload (HTTP {status_code}): invalid JSON."),
        )

    if not isinstance(payload, dict) or payload.get("status") != "ok":
        return ProbeResult(
            healthy=False,
            http_status=status_code,
            error=_truncate_error(f"Unexpected health payload (HTTP {status_code}): status is not 'ok'."),
        )

    return ProbeResult(healthy=True, http_status=status_code, error=None)


class MonitorStore(Protocol):
    def get_state(self, service_name: str) -> Optional[dict[str, Any]]: ...
    def upsert_state(self, row: dict[str, Any]) -> dict[str, Any]: ...
    def list_admin_emails(self) -> list[str]: ...
    def claim_notification(self, kind: str, ref: str, recipient: str) -> bool: ...
    def mark_notification_sent(self, kind: str, ref: str, sent_at: str) -> None: ...
    def release_notification_claim(self, kind: str, ref: str) -> None: ...
    def recent_admin_shutdown(self, since_iso: str) -> bool: ...


class SupabaseRestClient:
    """Minimal PostgREST client built strictly with Python standard library."""

    def __init__(self, supabase_url: str, service_role_key: str, *, timeout: float = 15.0):
        self.base_url = supabase_url.rstrip("/")
        self.key = service_role_key
        self.timeout = timeout

    def _request(
        self,
        method: str,
        path: str,
        *,
        query: Optional[dict[str, str]] = None,
        body: Any = None,
        prefer: Optional[str] = None,
    ) -> Any:
        url = f"{self.base_url}/rest/v1/{path.lstrip('/')}"
        if query:
            url = f"{url}?{urllib.parse.urlencode(query)}"
        headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Accept": "application/json",
        }
        data: Optional[bytes] = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if prefer:
            headers["Prefer"] = prefer

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8", errors="replace").strip()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read(1024).decode("utf-8", errors="replace").strip()
            except Exception:
                detail = ""
            raise RuntimeError(f"Supabase REST {method} {path} failed (HTTP {exc.code}): {detail}") from exc

    def get_state(self, service_name: str) -> Optional[dict[str, Any]]:
        rows = self._request(
            "GET",
            "server_availability_state",
            query={"service_name": f"eq.{service_name}", "select": "*"},
        )
        return rows[0] if rows else None

    def upsert_state(self, row: dict[str, Any]) -> dict[str, Any]:
        rows = self._request(
            "POST",
            "server_availability_state",
            query={"on_conflict": "service_name"},
            body=row,
            prefer="resolution=merge-duplicates,return=representation",
        )
        return rows[0] if rows else dict(row)

    def list_admin_emails(self) -> list[str]:
        rows = self._request(
            "GET",
            "profiles",
            query={"role": "eq.admin", "select": "email"},
        )
        return sorted({str(r["email"]).strip() for r in (rows or []) if r.get("email") and str(r["email"]).strip()})

    def claim_notification(self, kind: str, ref: str, recipient: str) -> bool:
        rows = self._request(
            "POST",
            "notification_log",
            query={"on_conflict": "kind,ref"},
            body={
                "kind": kind,
                "ref": ref,
                "user_id": None,
                "recipient": recipient,
                "status": "sending",
            },
            prefer="resolution=ignore-duplicates,return=representation",
        )
        return bool(rows)

    def mark_notification_sent(self, kind: str, ref: str, sent_at: str) -> None:
        self._request(
            "PATCH",
            "notification_log",
            query={"kind": f"eq.{kind}", "ref": f"eq.{ref}"},
            body={"status": "sent", "sent_at": sent_at},
            prefer="return=minimal",
        )

    def release_notification_claim(self, kind: str, ref: str) -> None:
        self._request(
            "DELETE",
            "notification_log",
            query={"kind": f"eq.{kind}", "ref": f"eq.{ref}"},
            prefer="return=minimal",
        )

    def recent_admin_shutdown(self, since_iso: str) -> bool:
        try:
            rows = self._request(
                "GET",
                "admin_action_log",
                query={
                    "action": "eq.server.shutdown",
                    "created_at": f"gte.{since_iso}",
                    "select": "id",
                    "limit": "1",
                },
            )
            return bool(rows)
        except Exception:
            return False


def resolve_admin_recipients(store: MonitorStore) -> list[str]:
    raw = os.getenv("ADMIN_ALERT_EMAILS", "").strip()
    if raw:
        seen: set[str] = set()
        out: list[str] = []
        for item in raw.split(","):
            addr = item.strip()
            key = addr.lower()
            if addr and key not in seen:
                seen.add(key)
                out.append(addr)
        return out
    return store.list_admin_emails()


def _initial_state(service_name: str, health_url: str) -> dict[str, Any]:
    return {
        "service_name": service_name,
        "health_url": health_url,
        "status": "up",
        "consecutive_failures": 0,
        "consecutive_successes": 0,
        "first_failure_at": None,
        "down_since": None,
        "down_alert_sent_at": None,
        "recovered_at": None,
        "current_incident_id": None,
        "pending_recovery_incident_id": None,
        "pending_recovery_down_since": None,
        "pending_recovery_at": None,
        "last_checked_at": None,
        "last_http_status": None,
        "last_error": None,
        "last_probe_request_id": None,
        "last_dispatch_at": None,
        "last_alert_at": None,
        "flapping_transitions": 0,
        "flapping_window_started_at": None,
        "updated_at": None,
    }


def _is_flapping_cooled_down(
    state: dict[str, Any],
    now: datetime,
    *,
    flapping_window_seconds: int,
    flapping_max_alerts: int,
    flapping_cooldown_seconds: int,
) -> bool:
    win_start = _parse_ts(state.get("flapping_window_started_at"))
    transitions = int(state.get("flapping_transitions") or 0)
    last_alert = _parse_ts(state.get("last_alert_at"))
    if win_start is None or (now - win_start).total_seconds() > flapping_window_seconds:
        return False
    if transitions < flapping_max_alerts:
        return False
    if last_alert is None:
        return False
    return (now - last_alert).total_seconds() < flapping_cooldown_seconds


def _current_flapping_note(
    state: dict[str, Any],
    now: datetime,
    *,
    flapping_window_seconds: int,
    flapping_max_alerts: int,
    will_increment: bool = True,
) -> Optional[str]:
    win_start = _parse_ts(state.get("flapping_window_started_at"))
    transitions = int(state.get("flapping_transitions") or 0)
    if win_start is None or (now - win_start).total_seconds() > flapping_window_seconds:
        projected = 1 if will_increment else 0
    else:
        projected = transitions + (1 if will_increment else 0)
    if projected >= flapping_max_alerts:
        return (
            "High restart frequency detected (flapping); subsequent status emails are rate-limited "
            "for 15 minutes to avoid flooding your inbox."
        )
    return None


def _record_alert_dispatched(
    state: dict[str, Any],
    now: datetime,
    *,
    flapping_window_seconds: int,
) -> None:
    win_start = _parse_ts(state.get("flapping_window_started_at"))
    if win_start is None or (now - win_start).total_seconds() > flapping_window_seconds:
        state["flapping_window_started_at"] = now.isoformat()
        state["flapping_transitions"] = 1
    else:
        state["flapping_transitions"] = int(state.get("flapping_transitions") or 0) + 1
    state["last_alert_at"] = now.isoformat()


def _deliver_to_recipients(
    *,
    store: MonitorStore,
    kind: str,
    incident_id: str,
    recipients: list[str],
    build_email: Callable[[], email_templates.EmailContent],
    send_fn: Callable[[str, email_templates.EmailContent], None],
    now_fn: Callable[[], datetime],
    sleep_fn: Callable[[float], None],
    smtp_retries: int = 2,
) -> tuple[bool, int, int]:
    """Delivers an incident alert once per recipient via `notification_log`.

    Returns `(all_handled, sent_count, failed_count)`. Failed recipients release
    their claim so a later run retries only the recipients that failed.
    """
    if not recipients:
        logger.warning("No admin alert recipients resolved; skipping %s email (%s)", kind, incident_id)
        return False, 0, 0
    if not mailer.is_configured():
        logger.warning("SMTP is not configured; deferring %s email (%s)", kind, incident_id)
        return False, 0, len(recipients)

    content = build_email()
    sent_count = 0
    claimed_or_sent = 0
    failed_count = 0

    for to in recipients:
        ref = f"{incident_id}:{to}"
        if not store.claim_notification(kind, ref, to):
            logger.info("Alert %s already sent/claimed for %s", kind, mailer.mask_address(to))
            claimed_or_sent += 1
            continue

        delivered = False
        last_exc: Optional[Exception] = None
        for attempt in range(max(1, smtp_retries)):
            try:
                send_fn(to, content)
                delivered = True
                break
            except Exception as exc:
                last_exc = exc
                if attempt + 1 < max(1, smtp_retries):
                    sleep_fn(1.0)

        if delivered:
            try:
                store.mark_notification_sent(kind, ref, now_fn().isoformat())
            except Exception:
                logger.exception("Sent %s to %s but failed to mark sent", kind, mailer.mask_address(to))
            sent_count += 1
            claimed_or_sent += 1
            logger.info("Dispatched %s email to %s (incident=%s)", kind, mailer.mask_address(to), incident_id)
        else:
            failed_count += 1
            logger.warning(
                "SMTP delivery failed for %s to %s (incident=%s): %s",
                kind,
                mailer.mask_address(to),
                incident_id,
                last_exc,
            )
            try:
                store.release_notification_claim(kind, ref)
            except Exception:
                logger.exception("Failed releasing claim %s for %s", kind, mailer.mask_address(to))

    all_handled = claimed_or_sent == len(recipients) and failed_count == 0
    return all_handled, sent_count, failed_count


def _apply_probe_observation(
    state: dict[str, Any],
    probe: ProbeResult,
    now: datetime,
    *,
    confirm_failures: int,
    confirm_window_seconds: int,
) -> None:
    now_iso = now.isoformat()
    state["last_checked_at"] = now_iso
    state["last_http_status"] = probe.http_status
    state["last_error"] = _truncate_error(probe.error) if probe.error else None
    state["updated_at"] = now_iso

    if probe.healthy:
        prev_status = state.get("status")
        if prev_status == "down":
            state["status"] = "up"
            state["recovered_at"] = now_iso
            state["consecutive_successes"] = 1
            state["consecutive_failures"] = 0
            if state.get("down_alert_sent_at") and state.get("current_incident_id"):
                state["pending_recovery_incident_id"] = state["current_incident_id"]
                state["pending_recovery_down_since"] = (
                    state.get("down_since") or state.get("first_failure_at") or now_iso
                )
                state["pending_recovery_at"] = now_iso
            state["first_failure_at"] = None
            state["down_since"] = None
            state["down_alert_sent_at"] = None
            state["current_incident_id"] = None
        else:
            state["status"] = "up"
            state["consecutive_failures"] = 0
            state["consecutive_successes"] = int(state.get("consecutive_successes") or 0) + 1
            state["first_failure_at"] = None
            state["down_since"] = None
            state["last_error"] = None
        return

    # Unhealthy probe
    state["consecutive_successes"] = 0
    failures = int(state.get("consecutive_failures") or 0) + 1
    state["consecutive_failures"] = failures

    first_fail = _parse_ts(state.get("first_failure_at"))
    if first_fail is None:
        first_fail = now
        state["first_failure_at"] = now_iso

    if state.get("status") == "down":
        return

    elapsed = (now - first_fail).total_seconds()
    if failures >= confirm_failures and elapsed >= confirm_window_seconds:
        state["status"] = "down"
        state["down_since"] = first_fail.isoformat()
        state["down_alert_sent_at"] = None
        if not state.get("current_incident_id"):
            state["current_incident_id"] = uuid.uuid4().hex
    else:
        state["status"] = "degraded"


def run_monitor(
    *,
    store: MonitorStore,
    service_name: str = DEFAULT_SERVICE_NAME,
    health_url_override: Optional[str] = None,
    mode: str = "dispatch",
    confirm_failures: int = 3,
    confirm_window_seconds: int = 120,
    confirm_interval_seconds: int = 30,
    flapping_window_seconds: int = 1800,
    flapping_max_alerts: int = 4,
    flapping_cooldown_seconds: int = 900,
    dry_run: bool = False,
    probe_fn: Optional[Callable[[str], ProbeResult]] = None,
    send_fn: Optional[Callable[[str, email_templates.EmailContent], None]] = None,
    now_fn: Callable[[], datetime] = _utc_now,
    sleep_fn: Callable[[float], None] = time.sleep,
    smtp_retries: int = 2,
) -> dict[str, Any]:
    """Executes one monitor run (`dispatch` or `poll`), returning a status summary dict."""
    existing = store.get_state(service_name)
    default_url = health_url_override or os.getenv("HEALTH_CHECK_URL") or DEFAULT_HEALTH_URL
    state = dict(existing) if existing else _initial_state(service_name, default_url)
    if health_url_override:
        state["health_url"] = health_url_override
    elif not state.get("health_url"):
        state["health_url"] = default_url
    health_url = str(state["health_url"])

    probe_exec = probe_fn or (lambda url: probe_health(url))
    send_exec = send_fn or mailer.send_email

    started = now_fn()
    probe = probe_exec(health_url)
    _apply_probe_observation(
        state,
        probe,
        started,
        confirm_failures=confirm_failures,
        confirm_window_seconds=confirm_window_seconds,
    )

    if mode == "poll" and state.get("status") == "degraded":
        if not dry_run:
            state = store.upsert_state(state)
        max_loops = 10
        loops = 0
        while state.get("status") == "degraded" and loops < max_loops:
            elapsed = (now_fn() - started).total_seconds()
            first_fail = _parse_ts(state.get("first_failure_at")) or started
            since_first = (now_fn() - first_fail).total_seconds()
            if elapsed >= confirm_window_seconds + confirm_interval_seconds and since_first >= confirm_window_seconds:
                break
            sleep_for = max(1.0, float(confirm_interval_seconds))
            sleep_fn(sleep_for)
            loops += 1
            now_tick = now_fn()
            probe = probe_exec(health_url)
            _apply_probe_observation(
                state,
                probe,
                now_tick,
                confirm_failures=confirm_failures,
                confirm_window_seconds=confirm_window_seconds,
            )
            if not dry_run and state.get("status") == "degraded":
                state = store.upsert_state(state)

    now = now_fn()
    actions: list[str] = []
    sent_total = 0
    failed_total = 0
    admin_url = os.getenv("ADMIN_APP_URL", "").strip() or None

    need_down = state.get("status") == "down" and not state.get("down_alert_sent_at") and bool(state.get("current_incident_id"))
    need_recovery = bool(state.get("pending_recovery_incident_id"))

    if dry_run:
        if need_down:
            actions.append("would_send_server_down")
        if need_recovery:
            actions.append("would_send_server_recovered")
        if not actions:
            actions.append("noop_dry_run")
        return {
            "service": service_name,
            "mode": mode,
            "dry_run": True,
            "healthy": probe.healthy,
            "status": state.get("status"),
            "http_status": probe.http_status,
            "consecutive_failures": state.get("consecutive_failures"),
            "actions": actions,
            "sent_count": 0,
            "failed_count": 0,
        }

    # Check flapping cooldown before dispatching emails.
    cooled_down = _is_flapping_cooled_down(
        state,
        now,
        flapping_window_seconds=flapping_window_seconds,
        flapping_max_alerts=flapping_max_alerts,
        flapping_cooldown_seconds=flapping_cooldown_seconds,
    )

    if (need_down or need_recovery) and cooled_down:
        actions.append("suppressed_flapping")
        logger.warning("Alert dispatch suppressed by flapping cooldown (service=%s)", service_name)
    elif need_down or need_recovery:
        recipients = resolve_admin_recipients(store)

        # Prioritize pending recovery notice before any newly confirmed outage if both exist.
        if need_recovery:
            rec_id = str(state["pending_recovery_incident_id"])
            rec_down_since = _parse_ts(state.get("pending_recovery_down_since"))
            rec_at = _parse_ts(state.get("pending_recovery_at")) or now
            dur_seconds = (rec_at - rec_down_since).total_seconds() if rec_down_since else 0.0
            flapping_note = _current_flapping_note(
                state,
                now,
                flapping_window_seconds=flapping_window_seconds,
                flapping_max_alerts=flapping_max_alerts,
                will_increment=True,
            )
            all_ok, sent, failed = _deliver_to_recipients(
                store=store,
                kind="server_recovered",
                incident_id=rec_id,
                recipients=recipients,
                build_email=lambda: email_templates.server_recovered_email(
                    service_name=service_name,
                    health_url=health_url,
                    recovered_at=format_vn_datetime(rec_at),
                    downtime_duration=format_duration(dur_seconds),
                    down_since=format_vn_datetime(rec_down_since) if rec_down_since else "unknown",
                    flapping_note=flapping_note,
                    admin_url=admin_url,
                ),
                send_fn=send_exec,
                now_fn=now_fn,
                sleep_fn=sleep_fn,
                smtp_retries=smtp_retries,
            )
            sent_total += sent
            failed_total += failed
            if sent > 0:
                _record_alert_dispatched(state, now, flapping_window_seconds=flapping_window_seconds)
            if all_ok:
                state["pending_recovery_incident_id"] = None
                state["pending_recovery_down_since"] = None
                state["pending_recovery_at"] = None
                actions.append("sent_server_recovered")
            else:
                actions.append("retry_pending_recovery")

        if need_down:
            inc_id = str(state["current_incident_id"])
            symptom = str(state.get("last_error") or "Health check failed.")
            if state.get("last_http_status") in (502, 503, 504):
                since_iso = str(state.get("down_since") or state.get("first_failure_at") or now.isoformat())
                if store.recent_admin_shutdown(since_iso):
                    symptom = _truncate_error(
                        f"{symptom} (Note: an administrator triggered API shutdown via Admin Portal.)"
                    )
            flapping_note = _current_flapping_note(
                state,
                now,
                flapping_window_seconds=flapping_window_seconds,
                flapping_max_alerts=flapping_max_alerts,
                will_increment=True,
            )
            all_ok, sent, failed = _deliver_to_recipients(
                store=store,
                kind="server_down",
                incident_id=inc_id,
                recipients=recipients,
                build_email=lambda s=symptom: email_templates.server_down_email(
                    service_name=service_name,
                    health_url=health_url,
                    detected_at=format_vn_datetime(state.get("down_since") or now),
                    symptom=s,
                    consecutive_failures=int(state.get("consecutive_failures") or 1),
                    flapping_note=flapping_note,
                    admin_url=admin_url,
                ),
                send_fn=send_exec,
                now_fn=now_fn,
                sleep_fn=sleep_fn,
                smtp_retries=smtp_retries,
            )
            sent_total += sent
            failed_total += failed
            if sent > 0:
                _record_alert_dispatched(state, now, flapping_window_seconds=flapping_window_seconds)
            if all_ok:
                state["down_alert_sent_at"] = now.isoformat()
                actions.append("sent_server_down")
            else:
                actions.append("retry_pending_down")

    if not actions:
        actions.append("noop")

    state["updated_at"] = now_fn().isoformat()
    store.upsert_state(state)

    return {
        "service": service_name,
        "mode": mode,
        "dry_run": False,
        "healthy": probe.healthy,
        "status": state.get("status"),
        "http_status": probe.http_status,
        "consecutive_failures": state.get("consecutive_failures"),
        "actions": actions,
        "sent_count": sent_total,
        "failed_count": failed_total,
    }


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Etymos external backend availability monitor")
    parser.add_argument("--mode", choices=("dispatch", "poll"), default="dispatch")
    parser.add_argument("--service", default=DEFAULT_SERVICE_NAME)
    parser.add_argument("--health-url", default=None)
    parser.add_argument("--confirm-failures", type=int, default=3)
    parser.add_argument("--confirm-window-seconds", type=int, default=120)
    parser.add_argument("--confirm-interval-seconds", type=int, default=30)
    parser.add_argument("--flapping-window-seconds", type=int, default=1800)
    parser.add_argument("--flapping-max-alerts", type=int, default=4)
    parser.add_argument("--flapping-cooldown-seconds", type=int, default=900)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--json", action="store_true", dest="json_output")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    supabase_url = os.getenv("SUPABASE_URL", "").strip()
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not supabase_url or not supabase_key:
        logger.error("Missing required SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable")
        return 1

    store = SupabaseRestClient(supabase_url, supabase_key)
    try:
        summary = run_monitor(
            store=store,
            service_name=args.service,
            health_url_override=args.health_url,
            mode=args.mode,
            confirm_failures=args.confirm_failures,
            confirm_window_seconds=args.confirm_window_seconds,
            confirm_interval_seconds=args.confirm_interval_seconds,
            flapping_window_seconds=args.flapping_window_seconds,
            flapping_max_alerts=args.flapping_max_alerts,
            flapping_cooldown_seconds=args.flapping_cooldown_seconds,
            dry_run=args.dry_run,
        )
    except Exception:
        logger.exception("Uptime monitor run failed unexpectedly")
        return 1

    if args.json_output:
        print(json.dumps(summary))
    else:
        logger.info(
            "Monitor finished: service=%s status=%s healthy=%s actions=%s sent=%s failed=%s",
            summary["service"],
            summary["status"],
            summary["healthy"],
            ",".join(summary["actions"]),
            summary["sent_count"],
            summary["failed_count"],
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
