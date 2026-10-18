"""
Database tests for supabase/migrations/20261018080000_document_unlocked_tier.sql:
a credit raises one document to the matching tier atomically, and users can't
set `documents.unlocked_tier` themselves. Skipped without pgserver/psycopg,
like test_admin_delete_sql.py (whose database fixture this reuses).
"""
from __future__ import annotations

import json
import uuid

import pytest

pytest.importorskip("pgserver")
psycopg = pytest.importorskip("psycopg")

from test_payments_sql import as_user, make_user  # noqa: E402
from test_user_activity_log_sql import db  # noqa: E402,F401


def as_service(db, sql: str, params=()):
    """Run one statement as the backend's service-role client."""
    with db.transaction():
        db.execute("set local role service_role")
        db.execute("select set_config('request.jwt.claim.role', 'service_role', true)")
        return db.execute(sql, params).fetchall()


def make_doc(db, user: str) -> str:
    return str(db.execute(
        "insert into public.documents (user_id, title) values (%s, 'Essay') returning id", (user,)
    ).fetchone()[0])


def credits(db, user: str, standard: int, premium: int) -> None:
    db.execute(
        "update public.profiles set standard_credits = %s, premium_credits = %s where id = %s",
        (standard, premium, user),
    )


def unlock(db, user: str, doc: str, tier: str) -> dict:
    row = as_service(db, "select public.unlock_document_with_credit(%s, %s, %s)", (user, doc, tier))[0][0]
    return row if isinstance(row, dict) else json.loads(row)


def tier_of(db, doc: str) -> str | None:
    return db.execute("select unlocked_tier from public.documents where id = %s", (doc,)).fetchone()[0]


def test_standard_credit_unlocks_student_tier_and_is_spent(db):
    user = make_user(db)
    credits(db, user, 2, 0)
    doc = make_doc(db, user)
    result = unlock(db, user, doc, "student")
    assert result == {"status": "ok", "unlocked_tier": "student", "standard_credits": 1, "premium_credits": 0}
    assert tier_of(db, doc) == "student"


def test_unlocking_the_same_tier_again_is_free(db):
    user = make_user(db)
    credits(db, user, 1, 0)
    doc = make_doc(db, user)
    unlock(db, user, doc, "student")
    assert unlock(db, user, doc, "student")["status"] == "already_unlocked"
    assert db.execute("select standard_credits from public.profiles where id = %s", (user,)).fetchone()[0] == 0


def test_premium_credit_upgrades_a_student_document(db):
    user = make_user(db)
    credits(db, user, 1, 1)
    doc = make_doc(db, user)
    unlock(db, user, doc, "student")
    result = unlock(db, user, doc, "professional")
    assert result["status"] == "ok" and result["premium_credits"] == 0
    assert tier_of(db, doc) == "professional"
    # And a professional document never drops back to student.
    assert unlock(db, user, doc, "student")["status"] == "already_unlocked"
    assert tier_of(db, doc) == "professional"


def test_no_matching_credit_changes_nothing(db):
    user = make_user(db)
    credits(db, user, 0, 3)
    doc = make_doc(db, user)
    assert unlock(db, user, doc, "student")["status"] == "no_credits"
    assert tier_of(db, doc) is None


def test_someone_elses_document_is_not_found(db):
    owner, other = make_user(db), make_user(db)
    credits(db, other, 5, 5)
    doc = make_doc(db, owner)
    assert unlock(db, other, doc, "student") == {"status": "not_found"}
    assert tier_of(db, doc) is None


def test_users_cannot_call_the_function_directly(db):
    user = make_user(db)
    credits(db, user, 1, 0)
    doc = make_doc(db, user)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_user(db, user, "select public.unlock_document_with_credit(%s, %s, 'student')", (user, doc))


def test_users_cannot_set_the_tier_on_their_own_rows(db):
    user = make_user(db)
    doc = make_doc(db, user)
    with pytest.raises(psycopg.errors.RaiseException):
        as_user(db, user, "update public.documents set unlocked_tier = 'professional' where id = %s returning id", (doc,))
    with pytest.raises(psycopg.errors.RaiseException):
        as_user(
            db, user,
            "insert into public.documents (user_id, title, unlocked_tier) values (%s, 'x', 'student') returning id",
            (user,),
        )
    # Ordinary self-service edits still work.
    assert as_user(db, user, "update public.documents set title = 'Renamed' where id = %s returning id", (doc,))
