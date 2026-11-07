"""
Database tests for supabase/migrations/20261108000000_admin_action_log.sql:
admin changes are logged by the database, nobody else's are, and nobody can
write or edit the log. Skipped without pgserver/psycopg, like
test_payments_sql.py (whose stand-ins and helpers this reuses).
"""
from __future__ import annotations

import pytest

pgserver = pytest.importorskip("pgserver")
psycopg = pytest.importorskip("psycopg")

from psycopg.types.json import Jsonb  # noqa: E402

from test_payments_sql import MIGRATIONS, SEED, SUPABASE_STUB, as_user, make_user  # noqa: E402

AUTH_COLUMNS = """
alter table auth.users
  add column last_sign_in_at timestamptz,
  add column encrypted_password text,
  add column raw_app_meta_data jsonb default '{}'::jsonb;
"""


@pytest.fixture(scope="module")
def db(tmp_path_factory):
    server = pgserver.get_server(str(tmp_path_factory.mktemp("pg")), cleanup_mode="stop")
    with psycopg.connect(server.get_uri(), autocommit=True) as conn:
        conn.execute(SUPABASE_STUB)
        conn.execute(AUTH_COLUMNS)
        for migration in MIGRATIONS:
            conn.execute(migration.read_text())
        conn.execute(SEED.read_text())
        yield conn
    server.cleanup()


def entries(db, **where) -> list[dict]:
    clauses = " and ".join(f"{k} = %s" for k in where) or "true"
    cur = db.execute(f"select * from public.admin_action_log where {clauses} order by id", tuple(where.values()))
    cols = [c.name for c in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def test_admin_profile_change_is_logged_with_what_changed(db):
    admin = make_user(db, admin=True)
    user = make_user(db)
    as_user(db, admin, "update public.profiles set plan_tier = 'student', standard_credits = 7 where id = %s returning id",
            (user,))
    [entry] = entries(db, actor_id=admin, target_user_id=user)
    assert entry["action"] == "profiles.update"
    assert entry["source"] == "portal"
    assert entry["target_table"] == "profiles" and entry["target_id"] == user
    assert entry["summary"] == f"{user[:8]}@example.com"
    assert entry["actor_email"] == f"{admin[:8]}@example.com"
    assert entry["changes"]["plan_tier"] == {"from": "free", "to": "student"}
    assert entry["changes"]["standard_credits"]["to"] == 7
    assert "updated_at" not in entry["changes"]


def test_users_own_changes_are_not_admin_actions(db):
    user = make_user(db)
    as_user(db, user, "update public.profiles set display_name = 'Me' where id = %s returning id", (user,))
    assert entries(db, actor_id=user) == []


def test_admin_without_authenticator_code_is_not_logged_as_admin(db):
    admin = make_user(db, admin=True)
    # aal1 = no authenticator code: is_admin() is false, so RLS refuses and nothing is logged.
    as_user(db, admin, "update public.profiles set display_name = 'x' where id = %s returning id", (admin,), aal="aal1")
    assert entries(db, actor_id=admin) == []


def test_system_changes_are_not_logged(db):
    user = make_user(db)
    db.execute("update public.profiles set standard_credits = 3 where id = %s", (user,))
    assert entries(db, target_user_id=user) == []


def test_inserts_and_deletes_record_the_row(db):
    admin = make_user(db, admin=True)
    as_user(db, admin, "insert into public.feature_flags (key, label, enabled, description) values ('test_flag', 'Test flag', true, 'x') returning key")
    as_user(db, admin, "delete from public.feature_flags where key = 'test_flag' returning key")
    created, deleted = entries(db, actor_id=admin, target_table="feature_flags")
    assert created["action"] == "feature_flags.insert" and created["changes"]["enabled"] == {"to": True}
    assert created["summary"] == "test_flag" and created["target_id"] == "test_flag"
    assert deleted["action"] == "feature_flags.delete" and deleted["changes"]["enabled"] == {"from": True}


def test_long_values_are_cut(db):
    admin = make_user(db, admin=True)
    user = make_user(db)
    as_user(db, admin, "update public.profiles set display_name = %s where id = %s returning id", ("x" * 1000, user))
    [entry] = entries(db, actor_id=admin, target_user_id=user)
    assert len(entry["changes"]["display_name"]["to"]) == 301


def test_admin_sign_in_is_logged(db):
    admin = make_user(db, admin=True)
    user = make_user(db)
    db.execute("update auth.users set last_sign_in_at = now() where id = any(%s)", ([admin, user],))
    assert [e["action"] for e in entries(db, actor_id=admin)] == ["auth.sign_in"]
    assert entries(db, actor_id=user) == []


def test_backend_writes_through_log_admin_action(db):
    admin = make_user(db, admin=True)
    db.execute("set role service_role")
    try:
        db.execute("select public.log_admin_action(%s, 'backend', 'server.restart_api', null, null, null, null, '{}', %s)",
                   (admin, Jsonb({"force": True})))
    finally:
        db.execute("reset role")
    [entry] = entries(db, actor_id=admin)
    assert entry["source"] == "backend" and entry["metadata"] == {"force": True}


def test_nobody_can_write_or_edit_the_log_directly(db):
    admin = make_user(db, admin=True)
    for sql in (
        "insert into public.admin_action_log (source, action) values ('portal', 'fake') returning id",
        "update public.admin_action_log set action = 'edited' returning id",
        "delete from public.admin_action_log returning id",
        "select public.log_admin_action(auth.uid(), 'portal', 'fake')",
    ):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_user(db, admin, sql)


def test_only_admins_can_read_the_log(db):
    admin = make_user(db, admin=True)
    user = make_user(db)
    as_user(db, admin, "update public.profiles set premium_credits = 2 where id = %s returning id", (user,))
    assert as_user(db, user, "select id from public.admin_action_log") == []
    assert as_user(db, admin, "select id from public.admin_action_log")
