"""
Database tests for supabase/migrations/20261105000000_admin_requires_mfa.sql:
admin powers need a session that passed an authenticator code (JWT aal2).
Skipped without pgserver/psycopg, like the other *_sql.py tests.
"""
from __future__ import annotations

import pytest

pytest.importorskip("pgserver")
psycopg = pytest.importorskip("psycopg")

from test_payments_sql import as_user, make_user  # noqa: E402
from test_user_activity_log_sql import db  # noqa: E402,F401


def visible_profiles(db, viewer: str, aal: str) -> int:
    return as_user(db, viewer, "select count(*) from public.profiles", aal=aal)[0][0]


def test_admin_with_a_code_sees_everyone(db):
    admin = make_user(db, admin=True)
    make_user(db)
    assert as_user(db, admin, "select public.is_admin(auth.uid())", aal="aal2") == [(True,)]
    assert visible_profiles(db, admin, "aal2") >= 2


def test_admin_without_a_code_is_a_normal_user(db):
    admin = make_user(db, admin=True)
    make_user(db)
    assert as_user(db, admin, "select public.is_admin(auth.uid())", aal="aal1") == [(False,)]
    assert visible_profiles(db, admin, "aal1") == 1  # only their own row


def test_admin_without_a_code_cannot_change_privileged_fields(db):
    admin = make_user(db, admin=True)
    user = make_user(db)
    # Not admin at aal1: RLS hides the other row, so nothing is updated.
    assert as_user(db, admin, "update public.profiles set plan_tier = 'premium' where id = %s returning id", (user,), aal="aal1") == []
    with pytest.raises(psycopg.errors.RaiseException, match="Not allowed to modify"):
        as_user(db, admin, "update public.profiles set standard_credits = 999 where id = %s returning id", (admin,), aal="aal1")


def test_normal_users_are_unchanged(db):
    user = make_user(db)
    for aal in ("aal1", "aal2"):
        assert as_user(db, user, "select public.is_admin(auth.uid())", aal=aal) == [(False,)]
        assert visible_profiles(db, user, aal) == 1


def test_checking_someone_else_and_the_backend_answer_as_before(db):
    admin = make_user(db, admin=True)
    user = make_user(db)
    assert as_user(db, user, "select public.is_admin(%s)", (admin,), aal="aal1") == [(True,)]
    # Service role / no JWT: no auth.uid(), so only the role decides.
    assert db.execute("select public.is_admin(%s)", (admin,)).fetchone() == (True,)
