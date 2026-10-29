"""
Database tests for supabase/migrations/20261029000000_waitlist_auto_approve.sql:
while waitlist_auto_approve is on, new sign-ups are approved as they are
created, and only an admin can flip it, which also approves everyone waiting.
Skipped without pgserver/psycopg, like test_user_activity_log_sql.py (whose
database fixture this reuses).
"""
from __future__ import annotations

import pytest

pytest.importorskip("pgserver")
psycopg = pytest.importorskip("psycopg")

from test_payments_sql import as_user, make_user  # noqa: E402
from test_user_activity_log_sql import db  # noqa: E402,F401

SET = "select public.admin_set_waitlist_auto_approve(%s)"


def access(db, user_id: str) -> tuple:
    return db.execute(
        "select access_status, access_note, access_reviewed_at is not null, access_reviewed_by::text"
        " from public.profiles where id = %s",
        (user_id,),
    ).fetchone()


def flag(db) -> bool:
    return db.execute("select enabled from public.feature_flags where key = 'waitlist_auto_approve'").fetchone()[0]


@pytest.fixture(autouse=True)
def flag_off(db):
    db.execute("update public.feature_flags set enabled = false where key = 'waitlist_auto_approve'")
    yield
    db.execute("update public.feature_flags set enabled = false where key = 'waitlist_auto_approve'")


def test_the_flag_starts_off_and_sign_ups_wait(db):
    assert flag(db) is False
    user = make_user(db)
    assert access(db, user) == ("waitlisted", None, False, None)


def test_sign_ups_are_approved_while_the_flag_is_on(db):
    db.execute("update public.feature_flags set enabled = true where key = 'waitlist_auto_approve'")
    user = make_user(db)
    assert access(db, user) == ("approved", "Auto-approved", True, None)


def test_turning_it_on_approves_everyone_waiting(db):
    admin = make_user(db, admin=True)
    waiting = [make_user(db), make_user(db)]
    rejected = make_user(db)
    db.execute("update public.profiles set access_status = 'rejected' where id = %s", (rejected,))

    [(approved,)] = as_user(db, admin, SET, (True,))

    assert approved >= 2  # earlier tests in this module may have left people waiting
    assert flag(db) is True
    for user in waiting:
        assert access(db, user) == ("approved", "Auto-approved", True, admin)
    assert access(db, rejected)[0] == "rejected"


def test_turning_it_off_approves_nobody(db):
    admin = make_user(db, admin=True)
    as_user(db, admin, SET, (True,))

    [(approved,)] = as_user(db, admin, SET, (False,))

    assert approved == 0
    assert flag(db) is False
    assert access(db, make_user(db))[0] == "waitlisted"


def test_only_admins_can_flip_it(db):
    user = make_user(db)
    db.execute("update public.profiles set access_status = 'approved' where id = %s", (user,))
    waiting = make_user(db)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_user(db, user, SET, (True,))
    assert flag(db) is False
    assert access(db, waiting)[0] == "waitlisted"
