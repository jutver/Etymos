"""
Database tests for supabase/migrations/20261017000000_announcements_overhaul.sql:
the per-kind content rules and who may write announcements and their images.
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
