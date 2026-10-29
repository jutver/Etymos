"""
Database tests for supabase/migrations/20261029010000_support_ban.sql: admins
can set and lift a support ban, users can't lift their own, both show in the
user activity log, and the inbound log accepts the new outcome. Skipped
without pgserver/psycopg, like test_user_activity_log_sql.py (whose database
fixture this reuses).
"""
from __future__ import annotations

import uuid

import pytest

pytest.importorskip("pgserver")
psycopg = pytest.importorskip("psycopg")

from test_payments_sql import make_user  # noqa: E402
from test_user_activity_log_sql import actions, db, log, run_as  # noqa: E402,F401

BAN = "update public.profiles set support_banned_permanent = true, support_ban_reason = 'spam' where id = %s"
LIFT = "update public.profiles set support_banned_permanent = false, support_ban_reason = null where id = %s"


def banned(db, user_id: str) -> bool:
    return db.execute("select support_banned_permanent from public.profiles where id = %s", (user_id,)).fetchone()[0]


def test_admin_bans_and_lifts_and_both_are_logged(db):
    uid = make_user(db)
    admin = make_user(db, admin=True)
    run_as(db, admin, BAN, (uid,))
    assert banned(db, uid) is True
    run_as(db, admin, LIFT, (uid,))
    assert banned(db, uid) is False

    entries = [e for e in log(db, uid) if e["category"] == "support"]
    assert [(e["action"], e["actor_kind"]) for e in entries] == [("support.banned", "admin"), ("support.unbanned", "admin")]
    assert entries[0]["metadata"] == {"permanent": True, "until": None, "reason": "spam"}


def test_users_cannot_lift_their_own_support_ban(db):
    uid = make_user(db)
    db.execute(BAN, (uid,))
    with pytest.raises(psycopg.errors.RaiseException):
        run_as(db, uid, LIFT, (uid,))
    assert banned(db, uid) is True
    # Their ordinary self-updates still go through.
    run_as(db, uid, "update public.profiles set display_name = 'Lan' where id = %s", (uid,))


def test_other_profile_changes_do_not_log_a_support_ban(db):
    uid = make_user(db)
    db.execute("update public.profiles set display_name = 'Lan' where id = %s", (uid,))
    assert not any(a.startswith("support.") for a in actions(db, uid))


def test_inbound_log_accepts_ignored_banned(db):
    db.execute(
        "insert into public.support_inbound_log (message_id, outcome) values (%s, 'ignored_banned')",
        (f"<{uuid.uuid4().hex}@example.com>",),
    )
