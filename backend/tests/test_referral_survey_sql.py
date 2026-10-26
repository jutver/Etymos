"""
Database tests for supabase/migrations/20261026000000_referral_survey.sql:
anyone can answer "How did you hear about Etymos?" once per browser, as
themselves or anonymously, and only admins can read the answers. Skipped
without pgserver/psycopg, like test_user_activity_log_sql.py (whose database
fixture this reuses).
"""
from __future__ import annotations

import uuid

import pytest

pytest.importorskip("pgserver")
psycopg = pytest.importorskip("psycopg")

from test_payments_sql import as_user, make_user  # noqa: E402
from test_user_activity_log_sql import db, run_as  # noqa: E402,F401

INSERT = (
    "insert into public.referral_survey_responses (visitor_id, user_id, source, other_text)"
    " values (%s, %s, %s, %s)"
)
SELECT = "select source from public.referral_survey_responses where visitor_id = %s"


def visitor() -> str:
    return uuid.uuid4().hex


def as_anon(db, sql: str, params=()):
    with db.transaction():
        db.execute("set local role anon")
        db.execute("select set_config('request.jwt.claim.role', 'anon', true)")
        cur = db.execute(sql, params)
        return cur.fetchall() if cur.description else []


def test_visitors_answer_signed_out_or_as_themselves(db):
    user = make_user(db)
    anon_visitor, user_visitor = visitor(), visitor()
    as_anon(db, INSERT, (anon_visitor, None, "tiktok", None))
    run_as(db, user, INSERT, (user_visitor, user, "other", "A teacher mentioned it"))

    rows = db.execute(
        "select source, user_id, other_text from public.referral_survey_responses where visitor_id in (%s, %s)"
        " order by id", (anon_visitor, user_visitor)
    ).fetchall()
    assert [(r[0], r[1] and str(r[1]), r[2]) for r in rows] == [
        ("tiktok", None, None), ("other", user, "A teacher mentioned it"),
    ]


def test_nobody_answers_for_someone_else(db):
    user, other = make_user(db), make_user(db)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_anon(db, INSERT, (visitor(), user, "facebook", None))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_user(db, other, INSERT, (visitor(), user, "facebook", None))


def test_one_answer_per_browser(db):
    v = visitor()
    as_anon(db, INSERT, (v, None, "friend", None))
    with pytest.raises(psycopg.errors.UniqueViolation):
        as_anon(db, INSERT, (v, None, "facebook", None))


def test_only_known_sources_and_free_text_only_for_other(db):
    with pytest.raises(psycopg.errors.CheckViolation):
        as_anon(db, INSERT, (visitor(), None, "instagram", None))
    with pytest.raises(psycopg.errors.CheckViolation):
        as_anon(db, INSERT, (visitor(), None, "facebook", "my friend"))
    with pytest.raises(psycopg.errors.CheckViolation):
        as_anon(db, INSERT, (visitor(), None, "other", "x" * 201))


def test_only_admins_read_answers(db):
    user, admin = make_user(db), make_user(db, admin=True)
    v = visitor()
    run_as(db, user, INSERT, (v, user, "search", None))

    assert as_anon(db, SELECT, (v,)) == []
    assert as_user(db, user, SELECT, (v,)) == []
    assert as_user(db, admin, SELECT, (v,)) == [("search",)]
    # No update/delete policy: an answer is final.
    assert as_user(db, user, "delete from public.referral_survey_responses where visitor_id = %s returning id", (v,)) == []


def test_answers_outlive_a_deleted_account(db):
    user = make_user(db)
    v = visitor()
    run_as(db, user, INSERT, (v, user, "facebook", None))
    db.execute("delete from auth.users where id = %s", (user,))
    assert db.execute("select user_id, source from public.referral_survey_responses where visitor_id = %s", (v,)).fetchone() == (None, "facebook")
