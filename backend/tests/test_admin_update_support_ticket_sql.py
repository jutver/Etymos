"""
Database tests for supabase/migrations/20261018040000_admin_update_support_ticket.sql:
the admin app's direct ticket edits follow the backend's rules, and only
admins can make them. Skipped without pgserver/psycopg, like
test_user_activity_log_sql.py (whose database fixture this reuses).
"""
from __future__ import annotations

import pytest

pytest.importorskip("pgserver")
psycopg = pytest.importorskip("psycopg")

from test_payments_sql import as_user, make_user  # noqa: E402
from test_user_activity_log_sql import db, log  # noqa: E402,F401


def new_ticket(db, user_id: str, *, status: str = "open") -> int:
    return db.execute(
        "insert into public.support_tickets (user_id, requester_email, subject, status)"
        " values (%s, %s, 'Help', %s) returning number",
        (user_id, f"{user_id[:8]}@example.com", status),
    ).fetchone()[0]


def update(db, admin: str, number: int, **fields) -> dict:
    args = ", ".join(f"p_{k} => %s" for k in fields)
    cur = db.cursor()
    with db.transaction():
        cur.execute("set local role authenticated")
        cur.execute("select set_config('request.jwt.claim.sub', %s, true)", (admin,))
        cur.execute("select set_config('request.jwt.claim.role', 'authenticated', true)")
        cur.execute(
            f"select * from public.admin_update_support_ticket(p_number => %s, {args})",
            (number, *fields.values()),
        )
        cols = [c.name for c in cur.description]
        return dict(zip(cols, cur.fetchone()))


def test_status_sets_and_clears_timestamps(db):
    admin, user = make_user(db, admin=True), make_user(db)
    number = new_ticket(db, user)

    resolved = update(db, admin, number, status="resolved")
    assert resolved["status"] == "resolved" and resolved["resolved_at"] is not None
    assert resolved["closed_at"] is None

    closed = update(db, admin, number, status="closed")
    assert closed["closed_at"] is not None and closed["resolved_at"] == resolved["resolved_at"]

    reopened = update(db, admin, number, status="open")
    assert reopened["resolved_at"] is None and reopened["closed_at"] is None


def test_unchanged_fields_are_left_alone(db):
    admin, user = make_user(db, admin=True), make_user(db)
    number = new_ticket(db, user)
    update(db, admin, number, status="resolved", assigned_to=admin)

    row = update(db, admin, number, priority="high", category="billing")
    assert (row["status"], row["priority"], row["category"]) == ("resolved", "high", "billing")
    assert str(row["assigned_to"]) == admin and row["resolved_at"] is not None


def test_assign_and_unassign(db):
    admin, user = make_user(db, admin=True), make_user(db)
    number = new_ticket(db, user)
    assert str(update(db, admin, number, assigned_to=admin)["assigned_to"]) == admin
    assert update(db, admin, number, assigned_to="")["assigned_to"] is None


def test_only_admins_can_be_assigned(db):
    admin, user = make_user(db, admin=True), make_user(db)
    number = new_ticket(db, user)
    for bad in (user, "not-a-uuid"):
        with pytest.raises(psycopg.Error, match="invalid_assignee"):
            update(db, admin, number, assigned_to=bad)


def test_non_admins_cannot_update(db):
    user = make_user(db)
    number = new_ticket(db, user)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        update(db, user, number, status="closed")
    assert as_user(db, make_user(db, admin=True),
                   "select status from public.support_tickets where number = %s", (number,))[0][0] == "open"


def test_unknown_ticket(db):
    with pytest.raises(psycopg.Error, match="not_found"):
        update(db, make_user(db, admin=True), 999999, status="closed")


def test_status_change_is_logged_with_the_admin_as_actor(db):
    admin, user = make_user(db, admin=True), make_user(db)
    number = new_ticket(db, user)
    update(db, admin, number, status="resolved")
    entry = [e for e in log(db, user) if e["action"] == "support.ticket_status_changed"][-1]
    assert entry["actor_kind"] == "admin" and entry["metadata"]["number"] == number
