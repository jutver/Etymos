"""
Database tests for supabase/migrations/20261018060000_admin_delete_verification_and_support.sql:
admins delete verification requests and support tickets by id, by status or
all at once, and get back the Storage paths of the files to remove. Skipped
without pgserver/psycopg, like test_user_activity_log_sql.py (whose database
fixture this reuses).
"""
from __future__ import annotations

import json
import uuid

import pytest

pytest.importorskip("pgserver")
psycopg = pytest.importorskip("psycopg")

from test_payments_sql import as_user, make_user  # noqa: E402
from test_user_activity_log_sql import db  # noqa: E402,F401


def call(db, admin: str, fn: str, **args) -> dict:
    named = ", ".join(f"p_{k} => %s" for k in args)
    row = as_user(db, admin, f"select public.{fn}({named})", tuple(args.values()))[0][0]
    return row if isinstance(row, dict) else json.loads(row)


def verification(db, user: str, status: str) -> tuple[str, str]:
    path = f"{user}/{uuid.uuid4().hex}.png"
    row = db.execute(
        "insert into public.student_verification_requests (user_id, storage_path, status)"
        " values (%s, %s, %s) returning id, storage_path",
        (user, path, status),
    ).fetchone()
    return str(row[0]), row[1]


def ticket(db, user: str, status: str = "open", *, files: int = 0, raw_email: bool = False) -> tuple[str, set[str]]:
    tid = str(db.execute(
        "insert into public.support_tickets (user_id, requester_email, subject, status)"
        " values (%s, %s, 'Help', %s) returning id",
        (user, f"{user[:8]}@example.com", status),
    ).fetchone()[0])
    raw = f"{tid}/raw.eml" if raw_email else None
    mid = db.execute(
        "insert into public.support_messages (ticket_id, author_type, body, channel, raw_email_path)"
        " values (%s, 'user', 'Hi', 'email', %s) returning id",
        (tid, raw),
    ).fetchone()[0]
    paths = {raw} if raw else set()
    for i in range(files):
        path = f"{tid}/{i}-file.pdf"
        db.execute(
            "insert into public.support_attachments (ticket_id, message_id, path, filename, content_type, size_bytes)"
            " values (%s, %s, %s, 'file.pdf', 'application/pdf', 10)",
            (tid, mid, path),
        )
        paths.add(path)
    return tid, paths


def remaining(db, table: str, ids: list[str]) -> int:
    return db.execute(f"select count(*) from public.{table} where id = any(%s::uuid[])", (ids,)).fetchone()[0]


# --- verification ------------------------------------------------------------


def test_delete_verification_by_id_returns_its_file(db):
    admin, user = make_user(db, admin=True), make_user(db)
    keep, _ = verification(db, user, "pending")
    gone, path = verification(db, user, "rejected")
    result = call(db, admin, "admin_delete_verification_requests", ids=[gone])
    assert result == {"deleted": 1, "paths": [path]}
    assert remaining(db, "student_verification_requests", [keep, gone]) == 1


def test_delete_verification_by_status_keeps_the_rest_and_the_verified_flag(db):
    admin, user = make_user(db, admin=True), make_user(db)
    db.execute("update public.profiles set student_verified = true where id = %s", (user,))
    approved, _ = verification(db, user, "approved")
    rejected, _ = verification(db, user, "rejected")
    call(db, admin, "admin_delete_verification_requests", status="approved")
    assert remaining(db, "student_verification_requests", [approved, rejected]) == 1
    assert db.execute("select student_verified from public.profiles where id = %s", (user,)).fetchone()[0] is True


def test_delete_all_verification(db):
    admin, user = make_user(db, admin=True), make_user(db)
    ids = [verification(db, user, s)[0] for s in ("pending", "approved", "rejected")]
    assert call(db, admin, "admin_delete_verification_requests", all=True)["deleted"] >= 3
    assert remaining(db, "student_verification_requests", ids) == 0


# --- support -----------------------------------------------------------------


def test_delete_ticket_returns_attachments_and_raw_emails(db):
    admin, user = make_user(db, admin=True), make_user(db)
    tid, paths = ticket(db, user, files=2, raw_email=True)
    keep, _ = ticket(db, user)
    result = call(db, admin, "admin_delete_support_tickets", ids=[tid])
    assert result["deleted"] == 1 and set(result["paths"]) == paths
    assert remaining(db, "support_tickets", [tid, keep]) == 1
    assert db.execute("select count(*) from public.support_messages where ticket_id = %s", (tid,)).fetchone()[0] == 0


def test_delete_tickets_by_status(db):
    admin, user = make_user(db, admin=True), make_user(db)
    closed, _ = ticket(db, user, "closed")
    open_, _ = ticket(db, user, "open")
    call(db, admin, "admin_delete_support_tickets", status="closed")
    assert remaining(db, "support_tickets", [closed]) == 0
    assert remaining(db, "support_tickets", [open_]) == 1


def test_delete_all_tickets_clears_follow_up_links(db):
    admin, user = make_user(db, admin=True), make_user(db)
    first, _ = ticket(db, user, "closed")
    follow_up, _ = ticket(db, user)
    db.execute("update public.support_tickets set previous_ticket_id = %s where id = %s", (first, follow_up))
    call(db, admin, "admin_delete_support_tickets", all=True)
    assert remaining(db, "support_tickets", [first, follow_up]) == 0


# --- guards ------------------------------------------------------------------


@pytest.mark.parametrize("fn", ["admin_delete_verification_requests", "admin_delete_support_tickets"])
def test_non_admins_cannot_delete(db, fn):
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        call(db, make_user(db), fn, all=True)


@pytest.mark.parametrize("fn", ["admin_delete_verification_requests", "admin_delete_support_tickets"])
def test_exactly_one_scope(db, fn):
    admin = make_user(db, admin=True)
    with pytest.raises(psycopg.Error, match="exactly one"):
        call(db, admin, fn)
    with pytest.raises(psycopg.Error, match="exactly one"):
        call(db, admin, fn, status="closed", all=True)


def test_admins_can_delete_support_files(db):
    admin, user = make_user(db, admin=True), make_user(db)
    db.execute("grant select, delete on storage.objects to authenticated")
    name = f"{user}/delete-me.pdf"
    db.execute("insert into storage.objects (bucket_id, name) values ('support-attachments', %s)", (name,))
    delete = "delete from storage.objects where bucket_id = 'support-attachments' and name = %s returning name"
    assert as_user(db, user, delete, (name,)) == []
    assert as_user(db, admin, delete, (name,)) == [(name,)]
