"""
Database tests for supabase/migrations/20261017000000_announcements_overhaul.sql
20261018000000_announcements_bilingual.sql and 20261019000000_maintenance_bypass.sql:
the per-kind content rules, who may write announcements and their images, and
who gets through maintenance.
Skipped without pgserver/psycopg, like test_payments_sql.py (whose throwaway
database and helpers these reuse).
"""
from __future__ import annotations

import pytest

from test_payments_sql import as_user, db, make_user  # noqa: F401  (db is a fixture)

psycopg = pytest.importorskip("psycopg")


def insert(db, **cols):
    names = ", ".join(cols)
    marks = ", ".join(["%s"] * len(cols))
    return db.execute(
        f"insert into public.announcements ({names}) values ({marks}) returning kind, message", tuple(cols.values())
    ).fetchone()


def test_existing_rows_default_to_banner(db):
    assert insert(db, message="Hello") == ("banner", "Hello")


def test_banner_needs_a_message(db):
    with pytest.raises(psycopg.errors.CheckViolation):
        insert(db, kind="banner", message="  ")


def test_popup_can_be_image_only_but_not_empty(db):
    assert insert(db, kind="popup", image_path="a.png")[0] == "popup"
    assert insert(db, kind="popup", title="Sale")[0] == "popup"
    with pytest.raises(psycopg.errors.CheckViolation):
        insert(db, kind="popup")


def test_maintenance_needs_no_content(db):
    assert insert(db, kind="maintenance")[0] == "maintenance"


def test_unknown_kind_is_rejected(db):
    with pytest.raises(psycopg.errors.CheckViolation):
        insert(db, kind="toast", message="x")


def test_only_admins_write_announcements_and_images(db):
    user, admin = make_user(db), make_user(db, admin=True)
    sql = "insert into public.announcements (kind, message) values ('banner', 'hi') returning id"
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_user(db, user, sql)
    assert as_user(db, admin, sql)

    # Real Supabase grants this table to API roles; the stand-in doesn't.
    db.execute("grant insert, select on storage.objects to authenticated")
    db.execute("create policy test_read_all on storage.objects for select using (true)")
    img = "insert into storage.objects (bucket_id, name) values ('announcement-images', %s) returning bucket_id"
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_user(db, user, img, ("x.png",))
    as_user(db, admin, img, ("y.png",))
    assert db.execute("select count(*) from storage.objects where name = 'y.png'").fetchone()[0] == 1


def test_updated_at_moves_on_update(db):
    row_id = db.execute(
        "insert into public.announcements (message, updated_at) values ('x', now() - interval '1 day') returning id"
    ).fetchone()[0]
    db.execute("update public.announcements set is_active = true where id = %s", (row_id,))
    age = db.execute("select now() - updated_at < interval '1 minute' from public.announcements where id = %s", (row_id,))
    assert age.fetchone()[0]


def test_vietnamese_alone_is_enough(db):
    assert insert(db, kind="banner", message_vi="Xin chào") == ("banner", "")
    assert insert(db, kind="popup", title_vi="Khuyến mãi")[0] == "popup"
    with pytest.raises(psycopg.errors.CheckViolation):
        insert(db, kind="banner", message=" ", message_vi=" ")


def email_of(db, uid):
    return db.execute("select email from public.profiles where id = %s", (uid,)).fetchone()[0]


def test_maintenance_lets_through_admins_and_listed_emails_only(db):
    admin, listed, other = make_user(db, admin=True), make_user(db), make_user(db)
    row_id = insert_id(db, kind="maintenance")
    as_user(db, admin, "select public.set_maintenance_bypass(%s, %s)", (row_id, [f"  {email_of(db, listed).upper()} "]))

    check = "select public.my_maintenance_bypass(%s)"
    assert as_user(db, admin, check, (row_id,)) == [(True,)]
    assert as_user(db, listed, check, (row_id,)) == [(True,)]
    assert as_user(db, other, check, (row_id,)) == [(False,)]
    # The list belongs to that announcement only.
    assert as_user(db, listed, check, (insert_id(db, kind="maintenance"),)) == [(False,)]


def test_bypass_list_is_admin_only(db):
    admin, user = make_user(db, admin=True), make_user(db)
    row_id = insert_id(db, kind="maintenance")
    as_user(db, admin, "select public.set_maintenance_bypass(%s, %s)", (row_id, [email_of(db, user)]))

    assert as_user(db, user, "select email from public.maintenance_bypass") == []
    assert as_user(db, admin, "select email from public.maintenance_bypass where announcement_id = %s", (row_id,)) == [
        (email_of(db, user),)
    ]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_user(db, user, "select public.set_maintenance_bypass(%s, %s)", (row_id, ["me@example.com"]))


def test_setting_the_list_replaces_it_and_bumps_the_announcement(db):
    admin = make_user(db, admin=True)
    row_id = db.execute(
        "insert into public.announcements (kind, updated_at) values ('maintenance', now() - interval '1 day') returning id"
    ).fetchone()[0]
    as_user(db, admin, "select public.set_maintenance_bypass(%s, %s)", (row_id, ["a@example.com", "A@example.com"]))
    as_user(db, admin, "select public.set_maintenance_bypass(%s, %s)", (row_id, ["b@example.com"]))

    emails = db.execute("select email from public.maintenance_bypass where announcement_id = %s", (row_id,)).fetchall()
    assert emails == [("b@example.com",)]
    fresh = db.execute("select now() - updated_at < interval '1 minute' from public.announcements where id = %s", (row_id,))
    assert fresh.fetchone()[0]

    db.execute("delete from public.announcements where id = %s", (row_id,))
    assert db.execute("select count(*) from public.maintenance_bypass where announcement_id = %s", (row_id,)).fetchone()[0] == 0


def insert_id(db, **cols):
    names = ", ".join(cols)
    marks = ", ".join(["%s"] * len(cols))
    return db.execute(f"insert into public.announcements ({names}) values ({marks}) returning id", tuple(cols.values())).fetchone()[0]
