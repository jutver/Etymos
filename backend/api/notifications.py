"""
notifications.py
----------------
Account and billing emails the backend sends on its own (Supabase Auth only
sends signup confirmation and password-reset links).

Sent straight away by the code that sees the event:
  password_changed          POST /api/account/password-changed (from the web app)
  recovery_email_added      recovery_email.py, when an address is confirmed
  recovery_email_removed    recovery_email.py, when a confirmed address is removed/replaced
  account_deleted           app.py, after DELETE /api/account or an admin force-delete
  payment_receipt           payments.py, when the SePay webhook pays an order
  admin_transfer_alert      payments.py, when a transfer needs an admin

Found by the scheduler (run_scheduled_pass, every NOTIFY_INTERVAL_SECONDS):
  payment_receipt           paid orders the webhook didn't email (admin-linked, free)
  admin_transfer_alert      problem transfers not yet alerted
  plan_expiring_3d / _1d    paid terms ending within 3 days / 1 day
  plan_ended                terms that ended in the last 2 days
  verification_approved / verification_rejected
                            student verification reviewed in the last day

Every email is claimed in public.notification_log by (kind, ref) before it
is sent, so it goes out once however many times the event is noticed and
however many backend processes run. A failed send releases the claim; the
scheduler retries kinds it covers on its next pass. The scheduler only looks
back a short window, so turning it on never mails out old history.
"""

from __future__ import annotations

import logging
import math
import os
import re
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

import mailer
from email_templates import (
    EmailContent,
    account_deleted_email,
    admin_transfer_alert_email,
    password_changed_email,
    payment_receipt_email,
    plan_ended_email,
    plan_expiring_email,
    recovery_email_added_email,
    recovery_email_removed_email,
    verification_result_email,
)
from supabase_client import get_client

logger = logging.getLogger(__name__)

LOG = "notification_log"
VN_TZ = timezone(timedelta(hours=7))
ATTENTION_STATUSES = ["unmatched", "underpaid", "duplicate", "review"]
STATUS_LABELS = {
    "unmatched": "No matching order",
    "underpaid": "Underpaid",
    "duplicate": "Order already paid",
    "review": "Paid for a declined order",
}
PLAN_NAMES = {"student": "Standard", "professional": "Premium"}
PACK_NAMES = {"pack-standard": "Standard credit pack", "pack-premium": "Premium credit pack"}

# How far back the scheduler looks for events it may have missed.
RECENT = timedelta(days=1)
ENDED_RECENT = timedelta(days=2)


# --- formatting ----------------------------------------------------------------


def _parse_ts(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    value = value.replace("Z", "+00:00")
    value = re.sub(r"\.(\d+)", lambda m: "." + (m.group(1) + "000000")[:6], value)
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def vn_datetime(value: Optional[str | datetime]) -> str:
    dt = _parse_ts(value) if isinstance(value, str) else value
    if dt is None:
        return "—"
    return dt.astimezone(VN_TZ).strftime("%d %b %Y, %H:%M") + " (Vietnam time)"


def vn_date(value: Optional[str | datetime]) -> str:
    dt = _parse_ts(value) if isinstance(value, str) else value
    return dt.astimezone(VN_TZ).strftime("%d %b %Y") if dt else "—"


def vnd(amount) -> str:
    return f"{round(float(amount or 0)):,}".replace(",", ".") + " đ"


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --- claim + send ----------------------------------------------------------------


def deliver(
    kind: str,
    ref: str,
    recipient: Optional[str],
    build: Callable[[], EmailContent],
    *,
    user_id: Optional[str] = None,
    client=None,
) -> bool:
    """Send one email unless (kind, ref) was already sent. Returns True if it
    went out now. Never raises: a notification must not break its caller."""
    if not recipient or not mailer.is_configured():
        return False
    client = client or get_client()
    if client is None:
        return False
    try:
        claimed = (
            client.table(LOG)
            .upsert(
                {"kind": kind, "ref": ref, "user_id": user_id, "recipient": recipient, "status": "sending"},
                on_conflict="kind,ref",
                ignore_duplicates=True,
            )
            .execute()
        ).data
    except Exception:
        logger.exception("Couldn't claim %s/%s", kind, ref)
        return False
    if not claimed:
        return False  # already sent (or being sent) by someone else

    try:
        mailer.send_email(recipient, build())
    except Exception:
        logger.exception("Failed to send %s/%s", kind, ref)
        try:
            client.table(LOG).delete().eq("kind", kind).eq("ref", ref).execute()
        except Exception:
            logger.exception("Couldn't release claim %s/%s", kind, ref)
        return False

    try:
        client.table(LOG).update({"status": "sent", "sent_at": _now().isoformat()}).eq("kind", kind).eq(
            "ref", ref
        ).execute()
    except Exception:
        logger.exception("Sent %s/%s but couldn't mark it", kind, ref)
    return True


def _one_off() -> str:
    return uuid.uuid4().hex


# --- immediate notifications -------------------------------------------------------


def notify_password_changed(user_id: str, email: Optional[str]) -> None:
    changed_at = vn_datetime(_now())
    deliver(
        "password_changed",
        _one_off(),
        email,
        lambda: password_changed_email(account_email=email or "", changed_at=changed_at),
        user_id=user_id,
    )


def notify_recovery_email_added(user_id: str, account_email: Optional[str], recovery_email: str) -> None:
    deliver(
        "recovery_email_added",
        _one_off(),
        account_email,
        lambda: recovery_email_added_email(account_email=account_email or "", recovery_email=recovery_email),
        user_id=user_id,
    )


def notify_recovery_email_removed(
    user_id: str, account_email: Optional[str], old_email: str, new_email: Optional[str]
) -> None:
    deliver(
        "recovery_email_removed",
        _one_off(),
        account_email,
        lambda: recovery_email_removed_email(
            account_email=account_email or "", old_email=old_email, new_email=new_email
        ),
        user_id=user_id,
    )


def notify_account_deleted(email: Optional[str]) -> None:
    # user_id stays null: the profile row is gone.
    deliver("account_deleted", _one_off(), email, lambda: account_deleted_email(account_email=email or ""))


def _profiles_by_id(client, ids: list[str], columns: str) -> dict[str, dict]:
    ids = [i for i in set(ids) if i]
    if not ids:
        return {}
    rows = client.table("profiles").select(columns).in_("id", ids).execute().data or []
    return {r["id"]: r for r in rows}


def _receipt_result(order: dict, profile: dict, client) -> str:
    if order.get("kind") == "plan":
        name = PLAN_NAMES.get(order.get("plan_tier") or "", "Your")
        ends = profile.get("plan_expires_at")
        return f"Your {name} plan is active until {vn_date(ends)}." if ends else f"Your {name} plan is active."
    checks = 1
    try:
        pack = client.table("credit_packs").select("checks").eq("id", order.get("pack_id")).limit(1).execute().data
        checks = int(pack[0]["checks"]) if pack else 1
    except Exception:
        logger.exception("Couldn't read credit pack %s", order.get("pack_id"))
    added = checks * int(order.get("quantity") or 1)
    return f"{added} credit{'s' if added != 1 else ''} {'were' if added != 1 else 'was'} added to your account."


def _order_item(order: dict) -> str:
    if order.get("kind") == "plan":
        cycle = "yearly" if order.get("billing_cycle") == "annual" else "monthly"
        return f"{PLAN_NAMES.get(order.get('plan_tier') or '', 'Plan')} plan ({cycle})"
    qty = int(order.get("quantity") or 1)
    name = PACK_NAMES.get(order.get("pack_id") or "", "Credit pack")
    return f"{name} ×{qty}" if qty > 1 else name


def send_receipts(orders: list[dict], client) -> int:
    profiles = _profiles_by_id(client, [o.get("user_id") for o in orders], "id, email, plan_expires_at")
    sent = 0
    for order in orders:
        profile = profiles.get(order.get("user_id"))
        if not profile:
            continue
        sent += deliver(
            "payment_receipt",
            order["id"],
            profile.get("email"),
            lambda o=order, p=profile: payment_receipt_email(
                item=_order_item(o),
                amount=vnd(o.get("paid_amount") if o.get("paid_amount") is not None else o.get("amount")),
                order_code=o.get("payment_code") or o["id"][:8],
                paid_at=vn_datetime(o.get("paid_at")),
                result=_receipt_result(o, p, client),
            ),
            user_id=order.get("user_id"),
            client=client,
        )
    return sent


def notify_payment_receipt(order_id: str) -> None:
    client = get_client()
    if client is None:
        return
    try:
        rows = client.table("checkout_events").select("*").eq("id", order_id).eq("status", "success").execute().data
        send_receipts(rows or [], client)
    except Exception:
        logger.exception("Payment receipt failed for order %s", order_id)


def admin_recipients(client) -> list[str]:
    configured = [e.strip() for e in os.getenv("ADMIN_ALERT_EMAILS", "").split(",") if e.strip()]
    if configured:
        return configured
    rows = client.table("profiles").select("email").eq("role", "admin").execute().data or []
    return sorted({r["email"] for r in rows if r.get("email")})


def send_admin_alerts(transactions: list[dict], client) -> int:
    recipients = admin_recipients(client)
    admin_url = os.getenv("ADMIN_APP_URL", "").strip() or None
    sent = 0
    for tx in transactions:
        for to in recipients:
            sent += deliver(
                "admin_transfer_alert",
                f"{tx['id']}:{to}",
                to,
                lambda t=tx: admin_transfer_alert_email(
                    amount=vnd(t.get("amount")),
                    status_label=STATUS_LABELS.get(t.get("status") or "", t.get("status") or ""),
                    note=t.get("note") or "",
                    content=t.get("content") or "",
                    reference=t.get("reference_code") or "",
                    received_at=vn_datetime(t.get("transaction_date") or t.get("received_at")),
                    admin_url=admin_url,
                ),
                client=client,
            )
    return sent


def notify_admin_transfer(transaction_id: str) -> None:
    client = get_client()
    if client is None:
        return
    try:
        rows = (
            client.table("payment_transactions")
            .select("*")
            .eq("id", transaction_id)
            .in_("status", ATTENTION_STATUSES)
            .execute()
        ).data
        send_admin_alerts(rows or [], client)
    except Exception:
        logger.exception("Admin alert failed for transaction %s", transaction_id)


# --- scheduled pass ----------------------------------------------------------------


def _expiry_reminders(client, now: datetime) -> int:
    sent = 0
    rows = (
        client.table("profiles")
        .select("id, email, plan_tier, billing_cycle, plan_expires_at")
        .neq("plan_tier", "free")
        .gt("plan_expires_at", now.isoformat())
        .lte("plan_expires_at", (now + timedelta(days=3)).isoformat())
        .execute()
    ).data or []
    for p in rows:
        ends = _parse_ts(p["plan_expires_at"])
        if ends is None:
            continue
        remaining = ends - now
        kind = "plan_expiring_1d" if remaining <= timedelta(days=1) else "plan_expiring_3d"
        days_left = max(1, math.ceil(remaining.total_seconds() / 86400))
        sent += deliver(
            kind,
            f"{p['id']}:{p['plan_expires_at']}",
            p.get("email"),
            lambda p=p, d=days_left: plan_expiring_email(
                plan_name=PLAN_NAMES.get(p["plan_tier"], "paid"),
                ends_at=vn_datetime(p["plan_expires_at"]),
                days_left=d,
                cycle=p.get("billing_cycle") or "monthly",
            ),
            user_id=p["id"],
            client=client,
        )
    return sent


def _ended_notices(client, now: datetime) -> int:
    sent = 0
    rows = (
        client.table("profiles")
        .select("id, email, plan_expires_at")
        .lte("plan_expires_at", now.isoformat())
        .gt("plan_expires_at", (now - ENDED_RECENT).isoformat())
        .execute()
    ).data or []
    for p in rows:
        sent += deliver(
            "plan_ended",
            f"{p['id']}:{p['plan_expires_at']}",
            p.get("email"),
            lambda p=p: plan_ended_email(ended_at=vn_date(p["plan_expires_at"])),
            user_id=p["id"],
            client=client,
        )
    return sent


def _verification_results(client, now: datetime) -> int:
    rows = (
        client.table("student_verification_requests")
        .select("id, user_id, status, reviewed_at")
        .in_("status", ["approved", "rejected"])
        .gte("reviewed_at", (now - RECENT).isoformat())
        .execute()
    ).data or []
    profiles = _profiles_by_id(client, [r["user_id"] for r in rows], "id, email")
    sent = 0
    for r in rows:
        sent += deliver(
            f"verification_{r['status']}",
            r["id"],
            (profiles.get(r["user_id"]) or {}).get("email"),
            lambda r=r: verification_result_email(approved=r["status"] == "approved"),
            user_id=r["user_id"],
            client=client,
        )
    return sent


def run_scheduled_pass(client=None, now: Optional[datetime] = None) -> dict[str, int]:
    """One sweep for everything time-based or missed. Safe to run any time."""
    client = client or get_client()
    if client is None or not mailer.is_configured():
        return {}
    now = now or _now()
    counts: dict[str, int] = {}
    steps: list[tuple[str, Callable[[], int]]] = [
        (
            "receipts",
            lambda: send_receipts(
                client.table("checkout_events")
                .select("*")
                .eq("status", "success")
                .gte("paid_at", (now - RECENT).isoformat())
                .execute()
                .data
                or [],
                client,
            ),
        ),
        (
            "admin_alerts",
            lambda: send_admin_alerts(
                client.table("payment_transactions")
                .select("*")
                .in_("status", ATTENTION_STATUSES)
                .gte("received_at", (now - RECENT).isoformat())
                .execute()
                .data
                or [],
                client,
            ),
        ),
        ("expiry_reminders", lambda: _expiry_reminders(client, now)),
        ("plan_ended", lambda: _ended_notices(client, now)),
        ("verification", lambda: _verification_results(client, now)),
    ]
    for name, step in steps:
        try:
            counts[name] = step()
        except Exception:
            # One failing query mustn't stop the other notifications.
            logger.exception("Notification step %s failed", name)
            counts[name] = 0
    if any(counts.values()):
        logger.info("Notifications sent: %s", counts)
    return counts


_scheduler: Optional[threading.Thread] = None


def start_scheduler() -> None:
    """Background thread running run_scheduled_pass every
    NOTIFY_INTERVAL_SECONDS (default 300). Off with NOTIFICATIONS_SCHEDULER=off."""
    global _scheduler
    if _scheduler is not None or os.getenv("NOTIFICATIONS_SCHEDULER", "on").lower() == "off":
        return
    interval = max(60, int(os.getenv("NOTIFY_INTERVAL_SECONDS", "300")))

    def loop() -> None:
        time.sleep(30)  # let the app finish starting
        while True:
            try:
                run_scheduled_pass()
            except Exception:
                logger.exception("Notification pass crashed")
            time.sleep(interval)

    _scheduler = threading.Thread(target=loop, name="notifications", daemon=True)
    _scheduler.start()
    logger.info("Notification scheduler started (every %ss)", interval)
