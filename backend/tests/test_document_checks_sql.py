"""
Database tests for supabase/migrations/20261021000000_document_checks.sql:
only the backend writes re-check history, owners can read their own, and the
plan seed carries each tier's free re-check limits. Skipped without
pgserver/psycopg, like test_document_unlock_sql.py.
"""
from __future__ import annotations

import pytest

pytest.importorskip("pgserver")
psycopg = pytest.importorskip("psycopg")

from test_document_unlock_sql import as_service, make_doc  # noqa: E402
from test_payments_sql import as_user, make_user  # noqa: E402
from test_user_activity_log_sql import db  # noqa: E402,F401

INSERT = (
    "insert into public.document_checks (document_id, kind, balance_source, changed_ratio, similarity_score, baseline_text)"
    " values (%s, %s, %s, 0.1, 12, 'text') returning id"
)


def test_backend_writes_and_owner_reads(db):
    owner, other = make_user(db), make_user(db)
    doc = make_doc(db, owner)
    as_service(db, INSERT, (doc, "free_recheck", None))
    as_service(db, INSERT, (doc, "paid_recheck", "premium"))

    assert len(as_user(db, owner, "select id from public.document_checks where document_id = %s", (doc,))) == 2
    assert as_user(db, other, "select id from public.document_checks where document_id = %s", (doc,)) == []


def test_users_cannot_write_their_own_history(db):
    owner = make_user(db)
    doc = make_doc(db, owner)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_user(db, owner, INSERT, (doc, "free_recheck", None))

    as_service(db, INSERT, (doc, "paid_recheck", "plan"))
    # No update/delete policy: the row is invisible to these statements.
    assert as_user(db, owner, "delete from public.document_checks where document_id = %s returning id", (doc,)) == []
    assert as_user(db, owner, "update public.document_checks set kind = 'free_recheck' where document_id = %s returning id", (doc,)) == []


def test_paid_rechecks_need_a_balance_and_free_ones_have_none(db):
    doc = make_doc(db, make_user(db))
    with pytest.raises(psycopg.errors.CheckViolation):
        as_service(db, INSERT, (doc, "paid_recheck", None))
    with pytest.raises(psycopg.errors.CheckViolation):
        as_service(db, INSERT, (doc, "free_recheck", "plan"))


def test_seeded_tier_limits(db):
    rows = db.execute(
        "select id, recheck_free_limit, recheck_change_limit from public.plan_definitions order by sort_order"
    ).fetchall()
    assert [(r[0], r[1], float(r[2])) for r in rows] == [
        ("free", 3, 0.30), ("student", 6, 0.50), ("professional", 10, 0.65),
    ]


def test_each_recheck_is_logged_for_the_owner(db):
    owner = make_user(db)
    doc = make_doc(db, owner)
    as_service(db, INSERT, (doc, "paid_recheck", "standard"))
    row = db.execute(
        "select category, action, ref_id, metadata from public.user_activity_log"
        " where user_id = %s and action = 'document.rechecked'", (owner,)
    ).fetchone()
    assert row[:3] == ("document", "document.rechecked", doc)
    assert row[3]["kind"] == "paid_recheck" and row[3]["balance_source"] == "standard"
