"""
Database tests for supabase/migrations/20261107000000_personal_messages.sql:
personal messages (pop-ups to one account), the record of when the recipient
saw one, and the activity log entries for both.
Skipped without pgserver/psycopg, like test_payments_sql.py (whose throwaway
database and helpers these reuse).
"""
from __future__ import annotations

import pytest

from test_payments_sql import as_user, db, make_user  # noqa: F401  (db is a fixture)

psycopg = pytest.importorskip("psycopg")


def email_of(db, uid: str) -> str:
    return db.execute("select email from public.profiles where id = %s", (uid,)).fetchone()[0]


def send(db, admin: str, to: str, *, title: str = "Hello") -> str:
    row_id = as_user(
        db, admin,
        "insert into public.announcements (kind, title, personal, audience, popup_placement, is_active, created_by)"
        " values ('popup', %s, true, 'emails', 'home', true, %s) returning id",
        (title, admin),
    )[0][0]
    as_user(db, admin, "select public.set_announcement_emails(%s, %s)", (row_id, [email_of(db, to)]))
    return str(row_id)


def mine(db, uid: str) -> list[str]:
    return [str(r[0]) for r in as_user(db, uid, "select id from public.my_announcements()")]


def actions(db, uid: str) -> list[tuple[str, str]]:
    return db.execute(
        "select action, actor_kind from public.user_activity_log where user_id = %s and category = 'support' order by id",
        (uid,),
    ).fetchall()


def test_personal_must_be_a_popup_for_chosen_people(db):
    with pytest.raises(psycopg.errors.CheckViolation):
        db.execute("insert into public.announcements (kind, message, personal) values ('banner', 'x', true)")
    with pytest.raises(psycopg.errors.CheckViolation):
        db.execute("insert into public.announcements (kind, title, personal) values ('popup', 'x', true)")


def test_only_the_recipient_sees_it_until_they_close_it(db):
    admin, user, other = make_user(db, admin=True), make_user(db), make_user(db)
    msg = send(db, admin, user)
    assert msg in mine(db, user)
    assert msg not in mine(db, other)

    as_user(db, user, "insert into public.announcement_views (announcement_id) values (%s) returning 1", (msg,))
    assert msg not in mine(db, user)
    seen = as_user(db, admin, "select user_id from public.announcement_views where announcement_id = %s", (msg,))
    assert [str(r[0]) for r in seen] == [user]


def test_views_are_private_and_only_for_your_own_messages(db):
    admin, user, other = make_user(db, admin=True), make_user(db), make_user(db)
    msg = send(db, admin, user)
    # Someone else can't mark it seen, for themselves or for the recipient.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_user(db, other, "insert into public.announcement_views (announcement_id) values (%s) returning 1", (msg,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_user(
            db, other,
            "insert into public.announcement_views (announcement_id, user_id) values (%s, %s) returning 1",
            (msg, user),
        )
    as_user(db, user, "insert into public.announcement_views (announcement_id) values (%s) returning 1", (msg,))
    assert as_user(db, user, "select * from public.announcement_views") == []


def test_global_announcements_still_show_after_a_view(db):
    admin, user = make_user(db, admin=True), make_user(db)
    row = as_user(
        db, admin,
        "insert into public.announcements (kind, title, is_active) values ('popup', 'Sale', true) returning id",
    )[0][0]
    as_user(db, user, "insert into public.announcement_views (announcement_id) values (%s) returning 1", (row,))
    assert str(row) in mine(db, user)


def test_sent_and_seen_are_logged_once(db):
    admin, user = make_user(db, admin=True), make_user(db)
    msg = send(db, admin, user)
    # An edit rewrites the email list; that isn't a second send.
    as_user(db, admin, "select public.set_announcement_emails(%s, %s)", (msg, [email_of(db, user)]))
    as_user(db, user, "insert into public.announcement_views (announcement_id) values (%s) returning 1", (msg,))
    assert actions(db, user) == [
        ("support.personal_message_sent", "admin"),
        ("support.personal_message_seen", "user"),
    ]


def test_global_email_lists_are_not_logged(db):
    admin, user = make_user(db, admin=True), make_user(db)
    row = as_user(
        db, admin,
        "insert into public.announcements (kind, title, audience, is_active) values ('popup', 'Hi', 'emails', true) returning id",
    )[0][0]
    as_user(db, admin, "select public.set_announcement_emails(%s, %s)", (row, [email_of(db, user)]))
    assert actions(db, user) == []
