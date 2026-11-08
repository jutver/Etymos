"""
Database tests for supabase/migrations/20261110000000_onboarding_trial_sample.sql:
the one-time 7-day Student trial, the sample document every new account gets,
and the tour flag. Skipped without pgserver/psycopg, like
test_user_activity_log_sql.py (whose database fixture this reuses).
"""
from __future__ import annotations

import pytest

pytest.importorskip("pgserver")
psycopg = pytest.importorskip("psycopg")

from test_payments_sql import as_user, make_order, make_user  # noqa: E402
from test_user_activity_log_sql import db  # noqa: E402,F401

START = "select public.start_student_trial()"
ENSURE = "select public.ensure_sample_document()::text"


def approved_user(db) -> str:
    uid = make_user(db)
    db.execute("update public.profiles set access_status = 'approved' where id = %s", (uid,))
    return uid


def plan(db, uid: str) -> tuple:
    return db.execute(
        "select plan_tier, billing_cycle, round(extract(epoch from plan_expires_at - now()) / 86400),"
        " trial_started_at is not null from public.profiles where id = %s",
        (uid,),
    ).fetchone()


def samples(db, uid: str) -> list[tuple]:
    return db.execute(
        "select id::text, is_trashed, unlocked_tier, check_state from public.documents"
        " where user_id = %s and is_sample order by uploaded_at",
        (uid,),
    ).fetchall()


# --- trial ------------------------------------------------------------------


def test_a_free_account_can_start_a_seven_day_student_trial(db):
    uid = approved_user(db)
    [(ends,)] = as_user(db, uid, START)
    assert ends is not None
    assert plan(db, uid) == ("student", None, 7, True)


def test_the_trial_can_only_be_started_once(db):
    uid = approved_user(db)
    as_user(db, uid, START)
    db.execute("update public.profiles set plan_tier = 'free', plan_expires_at = now() where id = %s", (uid,))
    with pytest.raises(psycopg.errors.RaiseException, match="TRIAL_ALREADY_USED"):
        as_user(db, uid, START)


def test_no_trial_on_a_paid_plan(db):
    uid = approved_user(db)
    db.execute(
        "update public.profiles set plan_tier = 'professional', plan_expires_at = now() + interval '20 days'"
        " where id = %s",
        (uid,),
    )
    with pytest.raises(psycopg.errors.RaiseException, match="TRIAL_ON_PAID_PLAN"):
        as_user(db, uid, START)


def test_no_trial_after_buying_a_plan(db):
    uid = approved_user(db)
    make_order(db, uid, kind="plan", plan_tier="student", billing_cycle="monthly", status="success")
    with pytest.raises(psycopg.errors.RaiseException, match="TRIAL_NOT_ELIGIBLE"):
        as_user(db, uid, START)


def test_no_trial_while_waitlisted(db):
    uid = make_user(db)
    with pytest.raises(psycopg.errors.RaiseException, match="TRIAL_NOT_ELIGIBLE"):
        as_user(db, uid, START)


def test_users_still_cannot_give_themselves_a_plan_or_reset_the_trial(db):
    uid = approved_user(db)
    with pytest.raises(psycopg.errors.RaiseException, match="Not allowed"):
        as_user(db, uid, "update public.profiles set plan_tier = 'student' where id = %s returning id", (uid,))
    as_user(db, uid, START)
    with pytest.raises(psycopg.errors.RaiseException, match="Not allowed"):
        as_user(db, uid, "update public.profiles set trial_started_at = null where id = %s returning id", (uid,))


def test_the_trial_lapses_to_free(db):
    uid = approved_user(db)
    as_user(db, uid, START)
    db.execute("update public.profiles set plan_expires_at = now() - interval '1 minute' where id = %s", (uid,))
    db.execute("select public.expire_lapsed_plans()")
    assert plan(db, uid)[0] == "free"


# --- tour flag ----------------------------------------------------------------


def test_new_accounts_see_the_tour_and_can_mark_it_done(db):
    uid = approved_user(db)
    assert db.execute("select tour_completed_at from public.profiles where id = %s", (uid,)).fetchone()[0] is None
    as_user(db, uid, "update public.profiles set tour_completed_at = now() where id = %s returning id", (uid,))
    assert db.execute("select tour_completed_at from public.profiles where id = %s", (uid,)).fetchone()[0] is not None


# --- sample document ------------------------------------------------------


def test_new_accounts_get_a_sample_report(db):
    uid = make_user(db)
    [(doc_id, trashed, tier, state)] = samples(db, uid)
    assert (trashed, tier, state) == (False, "student", "completed")
    matches = db.execute(
        "select detection_type, severity from public.document_matches where document_id = %s order by severity",
        (doc_id,),
    ).fetchall()
    assert sorted(matches) == [("semantic", "moderate"), ("traditional", "high"), ("traditional", "low")]
    linked = db.execute(
        "select count(*) from public.document_passages p join public.document_matches m on m.id = p.match_id"
        " where p.document_id = %s and position(m.user_snippet in p.text) > 0",
        (doc_id,),
    ).fetchone()[0]
    assert linked == 3
    # Seeding writes nothing to the user's activity log.
    assert db.execute(
        "select count(*) from public.user_activity_log where user_id = %s and category = 'document'", (uid,)
    ).fetchone()[0] == 0


def test_users_cannot_mark_their_own_documents_as_samples(db):
    uid = approved_user(db)
    with pytest.raises(psycopg.errors.RaiseException, match="Not allowed"):
        as_user(db, uid, "insert into public.documents (user_id, title, is_sample) values (%s, 'x', true) returning id", (uid,))
    [(doc_id, *_)] = samples(db, uid)
    with pytest.raises(psycopg.errors.RaiseException, match="Not allowed"):
        as_user(db, uid, "update public.documents set is_sample = false where id = %s returning id", (doc_id,))


def test_ensure_returns_restores_or_recreates_the_sample(db):
    uid = approved_user(db)
    [(doc_id, *_)] = samples(db, uid)

    assert as_user(db, uid, ENSURE) == [(doc_id,)]

    as_user(db, uid, "update public.documents set is_trashed = true where id = %s returning id", (doc_id,))
    assert as_user(db, uid, ENSURE) == [(doc_id,)]
    assert samples(db, uid)[0][1] is False

    as_user(db, uid, "delete from public.documents where id = %s returning id", (doc_id,))
    [(new_id,)] = as_user(db, uid, ENSURE)
    assert new_id != doc_id
    assert [s[0] for s in samples(db, uid)] == [new_id]
