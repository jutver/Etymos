"""
Tests for backend/api/notifications.py and the notification email templates.
Supabase and SMTP are in-memory fakes; nothing is sent.
"""
from __future__ import annotations

import itertools
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

import email_templates
import mailer
import notifications

NOW = datetime(2026, 10, 10, 3, 0, tzinfo=timezone.utc)


def iso(delta: timedelta) -> str:
    return (NOW + delta).isoformat()


# --- in-memory stand-in for the supabase-py query builder -----------------


class _Query:
    def __init__(self, db, table):
        self.db, self.table, self.filters = db, table, []
        self.op, self.payload, self.opts = "select", None, {}

    def select(self, *_):
        return self

    def limit(self, *_):
        return self

    def _f(self, fn):
        self.filters.append(fn)
        return self

    def eq(self, c, v):
        return self._f(lambda r: r.get(c) == v)

    def neq(self, c, v):
        return self._f(lambda r: r.get(c) != v)

    def in_(self, c, vs):
        return self._f(lambda r: r.get(c) in vs)

    def gt(self, c, v):
        return self._f(lambda r: r.get(c) is not None and notifications._parse_ts(r[c]) > notifications._parse_ts(v))

    def gte(self, c, v):
        return self._f(lambda r: r.get(c) is not None and notifications._parse_ts(r[c]) >= notifications._parse_ts(v))

    def lte(self, c, v):
        return self._f(lambda r: r.get(c) is not None and notifications._parse_ts(r[c]) <= notifications._parse_ts(v))

    def upsert(self, payload, on_conflict=None, ignore_duplicates=False):
        self.op, self.payload, self.opts = "upsert", payload, {"keys": on_conflict.split(","), "ignore": ignore_duplicates}
        return self

    def update(self, payload):
        self.op, self.payload = "update", payload
        return self

    def delete(self):
        self.op = "delete"
        return self

    def execute(self):
        if self.table in self.db.broken:
            raise RuntimeError(f"{self.table} unavailable")
        rows = self.db.tables.setdefault(self.table, [])
        match = [r for r in rows if all(f(r) for f in self.filters)]
        if self.op == "select":
            return SimpleNamespace(data=[dict(r) for r in match])
        if self.op == "upsert":
            keys = self.opts["keys"]
            if any(all(r.get(k) == self.payload[k] for k in keys) for r in rows):
                return SimpleNamespace(data=[])
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
        self.broken: set[str] = set()
        self.tables = {
            "profiles": [
                {"id": "admin-1", "email": "boss@etymos.site", "role": "admin", "plan_tier": "free", "plan_expires_at": None},
            ],
            "credit_packs": [{"id": "pack-standard", "checks": 1}, {"id": "pack-premium", "checks": 1}],
            "checkout_events": [],
            "payment_transactions": [],
            "student_verification_requests": [],
            "notification_log": [],
        }

    def table(self, name):
        return _Query(self, name)


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()
    sent: list = []
    fail = {"next": 0}

    def send(to, content):
        if fail["next"]:
            fail["next"] -= 1
            raise OSError("SMTP down")
        sent.append((to, content))

    monkeypatch.setattr(notifications, "get_client", lambda: db)
    monkeypatch.setattr(mailer, "is_configured", lambda: True)
    monkeypatch.setattr(mailer, "send_email", send)
    monkeypatch.delenv("ADMIN_ALERT_EMAILS", raising=False)
    monkeypatch.delenv("ADMIN_APP_URL", raising=False)
    return SimpleNamespace(db=db, sent=sent, fail=fail)


def subjects(env) -> list[str]:
    return [c.subject for _, c in env.sent]


ids = itertools.count(1)


def add_user(env, **over) -> str:
    uid = f"user-{next(ids)}"
    env.db.tables["profiles"].append(
        {"id": uid, "email": f"{uid}@example.com", "role": "user", "plan_tier": "free",
         "billing_cycle": None, "plan_expires_at": None, **over}
    )
    return uid


# --- deliver -----------------------------------------------------------------


def test_deliver_sends_once_per_kind_and_ref(env):
    build = lambda: email_templates.plan_ended_email(ended_at="1 Oct 2026")  # noqa: E731
    assert notifications.deliver("plan_ended", "u:1", "a@example.com", build) is True
    assert notifications.deliver("plan_ended", "u:1", "a@example.com", build) is False
    assert notifications.deliver("plan_ended", "u:2", "a@example.com", build) is True
    assert len(env.sent) == 2
    log = env.db.tables["notification_log"]
    assert all(r["status"] == "sent" and r["sent_at"] for r in log)


def test_failed_send_releases_the_claim_for_a_retry(env):
    build = lambda: email_templates.plan_ended_email(ended_at="1 Oct 2026")  # noqa: E731
    env.fail["next"] = 1
    assert notifications.deliver("plan_ended", "u:1", "a@example.com", build) is False
    assert env.db.tables["notification_log"] == []
    assert notifications.deliver("plan_ended", "u:1", "a@example.com", build) is True


def test_deliver_skips_without_recipient_or_smtp(env, monkeypatch):
    build = lambda: email_templates.plan_ended_email(ended_at="x")  # noqa: E731
    assert notifications.deliver("plan_ended", "r", None, build) is False
    monkeypatch.setattr(mailer, "is_configured", lambda: False)
    assert notifications.deliver("plan_ended", "r", "a@example.com", build) is False
    assert env.sent == []


def test_deliver_never_raises_when_the_log_is_down(env):
    env.db.broken.add("notification_log")
    assert notifications.deliver("plan_ended", "r", "a@example.com", lambda: None) is False


# --- immediate notifications -----------------------------------------------------


def test_security_notices(env):
    notifications.notify_password_changed("u1", "owner@example.com")
    notifications.notify_recovery_email_added("u1", "owner@example.com", "backup@example.com")
    notifications.notify_recovery_email_removed("u1", "owner@example.com", "backup@example.com", "new@example.com")
    notifications.notify_recovery_email_removed("u1", "owner@example.com", "backup@example.com", None)
    notifications.notify_account_deleted("owner@example.com")
    assert [to for to, _ in env.sent] == ["owner@example.com"] * 5
    assert subjects(env) == [
        "Your Etymos password was changed",
        "A recovery email was added to your Etymos account",
        "Your Etymos recovery email was changed",
        "Your Etymos recovery email was changed",
        "Your Etymos account has been deleted",
    ]
    replaced = email_templates.render_text(env.sent[2][1])
    assert "replaced with new@example.com" in replaced
    assert "was removed" in email_templates.render_text(env.sent[3][1])


def test_receipt_for_a_pack_and_a_plan(env):
    uid = add_user(env, plan_tier="student", plan_expires_at=iso(timedelta(days=365)))
    env.db.tables["checkout_events"] += [
        {"id": "o-pack", "user_id": uid, "status": "success", "kind": "pack", "pack_id": "pack-standard",
         "quantity": 3, "amount": 57000, "paid_amount": 57000, "payment_code": "ETMAAAAAAAA", "paid_at": iso(-timedelta(minutes=5))},
        {"id": "o-plan", "user_id": uid, "status": "success", "kind": "plan", "plan_tier": "student",
         "billing_cycle": "annual", "amount": 490000, "paid_amount": 490000, "payment_code": "ETMBBBBBBBB", "paid_at": iso(-timedelta(minutes=1))},
    ]
    notifications.notify_payment_receipt("o-pack")
    notifications.notify_payment_receipt("o-plan")
    notifications.notify_payment_receipt("o-plan")  # webhook redelivery: no second email
    assert subjects(env) == ["Payment received: Standard credit pack ×3", "Payment received: Standard plan (yearly)"]
    pack_text = email_templates.render_text(env.sent[0][1])
    assert "3 credits were added" in pack_text and "57.000 đ" in pack_text and "ETMAAAAAAAA" in pack_text
    assert "Standard plan is active until 10 Oct 2027" in email_templates.render_text(env.sent[1][1])


def test_receipt_not_sent_for_unpaid_orders(env):
    uid = add_user(env)
    env.db.tables["checkout_events"].append({"id": "o1", "user_id": uid, "status": "pending", "kind": "pack"})
    notifications.notify_payment_receipt("o1")
    assert env.sent == []


def test_admin_alert_goes_to_every_admin_once(env, monkeypatch):
    env.db.tables["payment_transactions"].append(
        {"id": "tx1", "status": "underpaid", "amount": 50000, "note": "Expected 57000, received 50000.",
         "content": "ETM7K2QF9XA", "reference_code": "FT1", "received_at": iso(timedelta(0))}
    )
    notifications.notify_admin_transfer("tx1")
    notifications.notify_admin_transfer("tx1")
    assert [to for to, _ in env.sent] == ["boss@etymos.site"]
    assert subjects(env) == ["[Etymos admin] Transfer needs attention: 50.000 đ (Underpaid)"]
    assert env.sent[0][1].button_url is None  # no ADMIN_APP_URL configured

    monkeypatch.setenv("ADMIN_ALERT_EMAILS", "a@etymos.site, b@etymos.site")
    monkeypatch.setenv("ADMIN_APP_URL", "https://admin.example.com/")
    notifications.notify_admin_transfer("tx1")
    assert [to for to, _ in env.sent][1:] == ["a@etymos.site", "b@etymos.site"]
    assert env.sent[1][1].button_url == "https://admin.example.com/revenue/transactions"


def test_no_admin_alert_for_matched_transfers(env):
    env.db.tables["payment_transactions"].append({"id": "tx1", "status": "matched", "amount": 1})
    notifications.notify_admin_transfer("tx1")
    assert env.sent == []


# --- scheduled pass ----------------------------------------------------------------


def test_expiry_reminders_3_days_then_1_day_once_each(env):
    uid = add_user(env, plan_tier="professional", billing_cycle="monthly", plan_expires_at=iso(timedelta(days=2, hours=12)))
    far = add_user(env, plan_tier="professional", plan_expires_at=iso(timedelta(days=10)))
    comped = add_user(env, plan_tier="professional", plan_expires_at=None)

    notifications.run_scheduled_pass(now=NOW)
    notifications.run_scheduled_pass(now=NOW + timedelta(minutes=5))
    assert subjects(env) == ["Your Etymos Premium plan ends in 3 days"]
    assert env.sent[0][0] == f"{uid}@example.com"

    notifications.run_scheduled_pass(now=NOW + timedelta(days=1, hours=13))
    notifications.run_scheduled_pass(now=NOW + timedelta(days=2))
    assert subjects(env)[1:] == ["Your Etymos Premium plan ends tomorrow"]
    assert all(to not in (f"{far}@example.com", f"{comped}@example.com") for to, _ in env.sent)


def test_renewing_resets_the_reminders_for_the_new_term(env):
    uid = add_user(env, plan_tier="student", billing_cycle="monthly", plan_expires_at=iso(timedelta(days=2)))
    notifications.run_scheduled_pass(now=NOW)
    profile = next(p for p in env.db.tables["profiles"] if p["id"] == uid)
    profile["plan_expires_at"] = iso(timedelta(days=32))  # renewed
    notifications.run_scheduled_pass(now=NOW + timedelta(hours=1))
    assert len(env.sent) == 1
    notifications.run_scheduled_pass(now=NOW + timedelta(days=29, hours=12))
    assert subjects(env)[1] == "Your Etymos Standard plan ends in 3 days"


def test_plan_ended_notice_only_for_recent_endings(env):
    recent = add_user(env, plan_tier="free", plan_expires_at=iso(-timedelta(hours=3)))
    add_user(env, plan_tier="free", plan_expires_at=iso(-timedelta(days=5)))
    notifications.run_scheduled_pass(now=NOW)
    notifications.run_scheduled_pass(now=NOW + timedelta(minutes=5))
    assert [to for to, _ in env.sent] == [f"{recent}@example.com"]
    assert subjects(env) == ["Your Etymos plan has ended"]


def test_scheduler_catches_receipts_alerts_and_verification(env):
    uid = add_user(env)
    env.db.tables["checkout_events"] += [
        {"id": "new", "user_id": uid, "status": "success", "kind": "pack", "pack_id": "pack-premium", "quantity": 1,
         "amount": 29000, "paid_amount": 29000, "payment_code": "ETMCCCCCCCC", "paid_at": iso(-timedelta(hours=2))},
        {"id": "old", "user_id": uid, "status": "success", "kind": "pack", "pack_id": "pack-premium", "quantity": 1,
         "amount": 29000, "paid_amount": 29000, "payment_code": "ETMDDDDDDDD", "paid_at": iso(-timedelta(days=3))},
    ]
    env.db.tables["payment_transactions"].append(
        {"id": "tx9", "status": "unmatched", "amount": 5000, "note": "", "received_at": iso(-timedelta(hours=1))}
    )
    env.db.tables["student_verification_requests"] += [
        {"id": "v1", "user_id": uid, "status": "approved", "reviewed_at": iso(-timedelta(hours=1))},
        {"id": "v2", "user_id": uid, "status": "rejected", "reviewed_at": iso(-timedelta(minutes=10))},
        {"id": "v3", "user_id": uid, "status": "pending", "reviewed_at": None},
    ]
    counts = notifications.run_scheduled_pass(now=NOW)
    assert counts == {"receipts": 1, "admin_alerts": 1, "expiry_reminders": 0, "plan_ended": 0, "verification": 2}
    assert sorted(subjects(env)) == sorted([
        "Payment received: Premium credit pack",
        "[Etymos admin] Transfer needs attention: 5.000 đ (No matching order)",
        "You're verified as a student on Etymos",
        "We couldn't verify your student status",
    ])
    assert notifications.run_scheduled_pass(now=NOW + timedelta(minutes=5)) == {
        "receipts": 0, "admin_alerts": 0, "expiry_reminders": 0, "plan_ended": 0, "verification": 0,
    }


def test_one_failing_step_doesnt_stop_the_others(env):
    env.db.broken.add("checkout_events")
    add_user(env, plan_tier="free", plan_expires_at=iso(-timedelta(hours=1)))
    counts = notifications.run_scheduled_pass(now=NOW)
    assert counts["receipts"] == 0 and counts["plan_ended"] == 1


# --- templates ----------------------------------------------------------------------


def test_templates_escape_user_text():
    content = email_templates.recovery_email_added_email(account_email="a<b>@x.com", recovery_email="<script>x</script>@y.com")
    html_out = email_templates.render_email(content)
    assert "<script>" not in html_out and "&lt;script&gt;" in html_out


def test_every_notification_template_renders():
    contents = [
        email_templates.password_changed_email(account_email="a@x.com", changed_at="now"),
        email_templates.recovery_email_added_email(account_email="a@x.com", recovery_email="b@x.com"),
        email_templates.recovery_email_removed_email(account_email="a@x.com", old_email="b@x.com", new_email=None),
        email_templates.payment_receipt_email(item="x", amount="1 đ", order_code="ETM", paid_at="now", result="ok"),
        email_templates.plan_expiring_email(plan_name="Premium", ends_at="soon", days_left=3, cycle="annual"),
        email_templates.plan_ended_email(ended_at="today"),
        email_templates.verification_result_email(approved=True),
        email_templates.verification_result_email(approved=False),
        email_templates.account_deleted_email(account_email="a@x.com"),
        email_templates.admin_transfer_alert_email(amount="1 đ", status_label="x", note="", content="", reference="",
                                                   received_at="now", admin_url=None),
    ]
    for c in contents:
        html_out, text = email_templates.render_email(c), email_templates.render_text(c)
        assert c.subject and c.heading in html_out and text.startswith(c.heading.split("<")[0][:10])


def test_vietnam_time_and_money_formatting():
    assert notifications.vn_datetime("2026-10-03T15:32:00Z") == "03 Oct 2026, 22:32 (Vietnam time)"
    assert notifications.vn_date("2026-10-03T18:00:00+00:00") == "04 Oct 2026"
    assert notifications.vnd(1790000) == "1.790.000 đ"
