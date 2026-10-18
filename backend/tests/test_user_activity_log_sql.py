"""
Database tests for supabase/migrations/20261018020000_user_activity_log.sql:
the triggers that fill user_activity_log, settle_checking_document, and who may
read or write the log. Skipped without pgserver/psycopg, like
test_payments_sql.py (whose stand-ins and helpers this reuses).
"""
from __future__ import annotations

import uuid

import pytest

pgserver = pytest.importorskip("pgserver")
psycopg = pytest.importorskip("psycopg")

from test_payments_sql import (  # noqa: E402
    MIGRATIONS,
    SEED,
    SUPABASE_STUB,
    as_user,
    make_order,
    make_user,
    webhook,
)

# The columns Supabase Auth keeps on auth.users that the sign-in trigger reads;
# added before the migrations run so the migration creates that trigger.
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


def log(db, user_id: str) -> list[dict]:
    cur = db.execute(
        "select actor_kind, category, action, subject, ref_id, metadata from public.user_activity_log"
        " where user_id = %s order by id",
        (user_id,),
    )
    cols = [c.name for c in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def actions(db, user_id: str) -> list[str]:
    return [e["action"] for e in log(db, user_id)]


def run_as(db, user_id: str, sql: str, params=()) -> None:
    """Like as_user, for a statement that returns no rows."""
    with db.transaction():
        db.execute("set local role authenticated")
        db.execute("select set_config('request.jwt.claim.sub', %s, true)", (user_id,))
        db.execute("select set_config('request.jwt.claim.role', 'authenticated', true)")
        db.execute(sql, params)


def new_document(db, user_id: str, *, title: str = "Essay", check_state: str = "completed") -> str:
    return str(
        as_user(
            db, user_id,
            "insert into public.documents (user_id, title, file_name, check_state) values (%s, %s, %s, %s) returning id",
            (user_id, title, f"{title}.pdf", check_state),
        )[0][0]
    )


# --- account -----------------------------------------------------------------


def test_signup_is_logged(db):
    uid = make_user(db)
    assert actions(db, uid) == ["account.created"]
    assert log(db, uid)[0]["actor_kind"] == "system"


def test_sign_in_and_password_change_are_logged(db):
    uid = make_user(db)
    db.execute("update auth.users set encrypted_password = 'x' where id = %s", (uid,))  # first password: not a change
    db.execute(
        "update auth.users set last_sign_in_at = now(), raw_app_meta_data = '{\"provider\": \"email\"}' where id = %s",
        (uid,),
    )
    db.execute("update auth.users set encrypted_password = 'y' where id = %s", (uid,))
    entries = log(db, uid)
    assert [e["action"] for e in entries] == ["account.created", "account.signed_in", "security.password_changed"]
    assert entries[1]["metadata"] == {"provider": "email"}


def test_admin_ban_and_unban_are_attributed_to_the_admin(db):
    uid = make_user(db)
    admin = make_user(db, admin=True)
    run_as(db, admin, "update public.profiles set banned_permanent = true, ban_reason = 'spam' where id = %s", (uid,))
    run_as(db, admin, "update public.profiles set banned_permanent = false, ban_reason = null where id = %s", (uid,))
    entries = log(db, uid)[1:]
    assert [(e["action"], e["actor_kind"]) for e in entries] == [
        ("account.banned", "admin"),
        ("account.unbanned", "admin"),
    ]
    assert entries[0]["metadata"]["reason"] == "spam"


def test_deleting_an_account_still_works_and_removes_its_log(db):
    uid = make_user(db)
    new_document(db, uid)
    db.execute("delete from auth.users where id = %s", (uid,))
    assert log(db, uid) == []


# --- plan and credits ----------------------------------------------------------


def test_credit_changes_record_from_to_and_delta(db):
    uid = make_user(db)
    db.execute("update public.profiles set standard_credits = standard_credits + 5 where id = %s", (uid,))
    db.execute("update public.profiles set standard_credits = standard_credits - 1 where id = %s", (uid,))
    entries = [e for e in log(db, uid) if e["action"] == "credits.changed"]
    assert [(e["metadata"]["from"], e["metadata"]["to"], e["metadata"]["delta"]) for e in entries] == [
        (0, 5, 5),
        (5, 4, -1),
    ]
    assert all(e["metadata"]["balance"] == "standard" and e["actor_kind"] == "system" for e in entries)


def test_admin_plan_change_is_one_entry(db):
    uid = make_user(db)
    admin = make_user(db, admin=True)
    run_as(
        db, admin,
        "update public.profiles set plan_tier = 'professional', billing_cycle = 'monthly',"
        " plan_expires_at = now() + interval '30 days' where id = %s",
        (uid,),
    )
    entries = [e for e in log(db, uid) if e["category"] == "plan"]
    assert len(entries) == 1
    assert entries[0]["action"] == "plan.changed" and entries[0]["actor_kind"] == "admin"
    assert entries[0]["metadata"]["plan_tier"] == {"from": "free", "to": "professional"}
    assert set(entries[0]["metadata"]) == {"plan_tier", "billing_cycle", "plan_expires_at"}


def test_lapsed_plan_is_logged_as_expired(db):
    uid = make_user(db)
    db.execute(
        "update public.profiles set plan_tier = 'professional', billing_cycle = 'monthly', checks_used_this_period = 3,"
        " plan_expires_at = now() - interval '1 minute' where id = %s",
        (uid,),
    )
    db.execute("select public.expire_lapsed_plans()")
    tail = actions(db, uid)[-2:]
    assert tail == ["plan.expired", "plan.usage_reset"]


def test_paid_order_logs_purchase_and_credit_top_up(db):
    uid = make_user(db)
    _, code = make_order(db, uid, amount=59000, quantity=3)
    webhook(db, amount=59000, code=code)
    acts = actions(db, uid)
    # The credits are granted inside the same transaction, just before the
    # order is marked paid.
    assert acts[1:] == ["purchase.started", "credits.changed", "purchase.completed"]
    top_up = [e for e in log(db, uid) if e["action"] == "credits.changed"]
    assert top_up and top_up[0]["metadata"]["delta"] > 0


# --- documents -----------------------------------------------------------------


def test_document_lifecycle_by_the_user(db):
    uid = make_user(db)
    doc = new_document(db, uid, title="Draft")
    run_as(db, uid, "update public.documents set title = 'Final' where id = %s", (doc,))
    run_as(db, uid, "update public.documents set project = 'Thesis' where id = %s", (doc,))
    run_as(db, uid, "update public.documents set is_trashed = true where id = %s", (doc,))
    run_as(db, uid, "update public.documents set is_trashed = false where id = %s", (doc,))
    run_as(db, uid, "delete from public.documents where id = %s", (doc,))
    entries = log(db, uid)[1:]
    assert [e["action"] for e in entries] == [
        "document.uploaded",
        "document.renamed",
        "document.moved",
        "document.trashed",
        "document.restored",
        "document.deleted",
    ]
    assert all(e["actor_kind"] == "user" and e["ref_id"] == doc for e in entries)
    assert entries[1]["metadata"] == {"from": "Draft", "to": "Final"}


def test_a_check_with_a_backend_report_row_logs_upload_and_completion_only(db):
    uid = make_user(db)
    placeholder = new_document(db, uid, title="Report", check_state="checking")
    # The backend persists its own report row with the service role.
    report = str(uuid.uuid4())
    db.execute(
        "insert into public.documents (id, user_id, title, file_name, status, similarity_score)"
        " values (%s, %s, 'Report.pdf', 'Report.pdf', 'clean', 12)",
        (report, uid),
    )
    settled = as_user(
        db, uid, "select public.settle_checking_document(%s, %s, %s::jsonb)",
        (placeholder, report, '{"status": "moderate", "similarity_score": 34, "word_count": 900}'),
    )[0][0]
    assert str(settled) == report

    entries = log(db, uid)[1:]
    assert [e["action"] for e in entries] == ["document.uploaded", "document.check_completed"]
    assert entries[1]["ref_id"] == report and entries[1]["subject"] == "Report"
    assert entries[1]["metadata"]["similarity_score"] == 34

    row = db.execute("select title, status, check_state from public.documents where id = %s", (report,)).fetchone()
    assert row == ("Report", "moderate", "completed")
    assert db.execute("select count(*) from public.documents where id = %s", (placeholder,)).fetchone()[0] == 0

    # A retry after the placeholder is gone resolves to the report, quietly.
    again = as_user(db, uid, "select public.settle_checking_document(%s, %s, '{}'::jsonb)", (placeholder, report))[0][0]
    assert str(again) == report
    assert len(log(db, uid)) == 3


def test_a_check_without_a_report_row_completes_the_placeholder(db):
    uid = make_user(db)
    placeholder = new_document(db, uid, check_state="checking")
    settled = as_user(
        db, uid, "select public.settle_checking_document(%s, null, %s::jsonb)", (placeholder, '{"status": "clean"}'),
    )[0][0]
    assert str(settled) == placeholder
    assert actions(db, uid)[1:] == ["document.uploaded", "document.check_completed"]


def test_a_failed_check_is_logged(db):
    uid = make_user(db)
    doc = new_document(db, uid, check_state="checking")
    run_as(db, uid, "update public.documents set check_state = 'failed', check_error = 'timeout' where id = %s", (doc,))
    entry = log(db, uid)[-1]
    assert entry["action"] == "document.check_failed" and entry["metadata"] == {"error": "timeout"}


def test_settle_cannot_touch_another_users_document(db):
    owner = make_user(db)
    other = make_user(db)
    placeholder = new_document(db, owner, check_state="checking")
    with pytest.raises(psycopg.errors.NoDataFound):
        as_user(db, other, "select public.settle_checking_document(%s, null, '{}'::jsonb)", (placeholder,))


# --- security ------------------------------------------------------------------


def test_recovery_email_lifecycle(db):
    uid = make_user(db)
    db.execute("insert into public.recovery_emails (user_id, email) values (%s, 'me@backup.test')", (uid,))
    db.execute("update public.recovery_emails set verified_at = now() where user_id = %s", (uid,))
    db.execute("update public.recovery_emails set reset_code_hash = 'h' where user_id = %s", (uid,))
    db.execute("delete from public.recovery_emails where user_id = %s", (uid,))
    assert actions(db, uid)[1:] == [
        "security.recovery_email_added",
        "security.recovery_email_verified",
        "security.password_reset_requested",
        "security.recovery_email_removed",
    ]


def test_only_admins_can_read_and_nobody_can_write_the_log(db):
    uid = make_user(db)
    admin = make_user(db, admin=True)
    assert as_user(db, uid, "select count(*) from public.user_activity_log")[0][0] == 0
    assert as_user(db, admin, "select count(*) from public.user_activity_log where user_id = %s", (uid,))[0][0] == 1
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        run_as(
            db, uid,
            "insert into public.user_activity_log (user_id, actor_kind, category, action)"
            " values (%s, 'user', 'account', 'account.fake')",
            (uid,),
        )
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_user(db, uid, "select public.log_user_activity(%s, 'account', 'account.fake')", (uid,))
