"""
Database tests for supabase/migrations/20261104000000_security_hardening.sql:
users can't rewrite the profile columns that discounts, support bans and the
waitlist trust, while the columns the web app does write still work.
Skipped without pgserver/psycopg, like the other *_sql.py tests.
"""
from __future__ import annotations

import pytest

pytest.importorskip("pgserver")
psycopg = pytest.importorskip("psycopg")

from test_payments_sql import as_user, make_user  # noqa: E402
from test_user_activity_log_sql import db  # noqa: E402,F401


@pytest.mark.parametrize(
    "column, value",
    [
        ("email", "vip@example.com"),
        ("created_at", "2020-01-01T00:00:00Z"),
        ("access_requested_at", "2020-01-01T00:00:00Z"),
    ],
)
def test_users_cannot_rewrite_trusted_profile_columns(db, column, value):
    user = make_user(db)
    with pytest.raises(psycopg.errors.RaiseException, match="Not allowed to modify"):
        as_user(db, user, f"update public.profiles set {column} = %s where id = %s returning id", (value, user))


def test_users_can_still_update_presence_and_name(db):
    user = make_user(db)
    as_user(db, user, "update public.profiles set last_seen_at = now(), display_name = 'Ana' where id = %s returning id", (user,))
    assert db.execute("select display_name from public.profiles where id = %s", (user,)).fetchone() == ("Ana",)


def test_admins_and_the_backend_can_still_change_email(db):
    admin = make_user(db, admin=True)
    user = make_user(db)
    as_user(db, admin, "update public.profiles set email = 'new@example.com' where id = %s returning id", (user,))
    db.execute("update public.profiles set email = 'other@example.com' where id = %s", (user,))
    assert db.execute("select email from public.profiles where id = %s", (user,)).fetchone() == ("other@example.com",)


def test_recovery_reset_counter_columns_exist(db):
    cols = {
        r[0]
        for r in db.execute(
            "select column_name from information_schema.columns"
            " where table_schema = 'public' and table_name = 'recovery_emails'"
        ).fetchall()
    }
    assert {"reset_codes_sent", "reset_codes_since"} <= cols
