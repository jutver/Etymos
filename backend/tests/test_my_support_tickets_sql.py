"""
Database tests for supabase/migrations/20261104010000_my_support_tickets.sql:
the My requests list reads the caller's own tickets (by account or login
address) and only their public fields. Skipped without pgserver/psycopg.
"""
from __future__ import annotations

import pytest

pytest.importorskip("pgserver")
psycopg = pytest.importorskip("psycopg")

from test_payments_sql import as_user, make_user  # noqa: E402
from test_user_activity_log_sql import db  # noqa: E402,F401


def make_ticket(db, *, user_id=None, email: str, subject: str) -> int:
    row = db.execute(
        "insert into public.support_tickets (user_id, requester_email, subject, priority)"
        " values (%s, %s, %s, 'high') returning number",
        (user_id, email, subject),
    ).fetchone()
    return int(row[0])


def email_of(db, user_id: str) -> str:
    return db.execute("select email from auth.users where id = %s", (user_id,)).fetchone()[0]


def test_lists_own_tickets_by_account_and_login_address(db):
    me = make_user(db)
    other = make_user(db)
    mine = make_ticket(db, user_id=me, email="old@example.com", subject="From my account")
    guest = make_ticket(db, email=email_of(db, me), subject="Sent before signing in")
    make_ticket(db, user_id=other, email=email_of(db, other), subject="Someone else")

    rows = as_user(db, me, "select number, subject from public.my_support_tickets()")
    assert {r[0] for r in rows} == {mine, guest}


def test_returns_only_public_fields(db):
    me = make_user(db)
    make_ticket(db, user_id=me, email=email_of(db, me), subject="Hi")
    cols = [
        r[0]
        for r in db.execute(
            "select unnest(proargnames) from pg_proc where proname = 'my_support_tickets'"
        ).fetchall()
    ]
    assert cols == ["number", "subject", "category", "status", "created_at", "updated_at", "last_agent_message_at"]


def test_users_still_cannot_read_the_table(db):
    me = make_user(db)
    make_ticket(db, user_id=me, email=email_of(db, me), subject="Hi")
    assert as_user(db, me, "select id from public.support_tickets") == []


def test_signed_out_callers_cannot_call_it(db):
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with db.transaction():
            db.execute("set local role anon")
            db.execute("select * from public.my_support_tickets()")
