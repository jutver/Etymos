"""
Database tests for supabase/migrations/20261018070000_discount_audience.sql:
discount audiences (emails, sign-up window, new customers), the private
plan_discounts table and my_plan_discounts(), which the web Pricing page
reads. Skipped without pgserver/psycopg, like test_user_activity_log_sql.py
(whose database fixture this reuses).
"""
from __future__ import annotations

import pytest

pytest.importorskip("pgserver")
psycopg = pytest.importorskip("psycopg")

from test_payments_sql import as_user, make_order, make_user  # noqa: E402
from test_user_activity_log_sql import db  # noqa: E402,F401


@pytest.fixture(autouse=True)
def _clean(db):
    db.execute("delete from public.plan_discounts")
    db.execute("delete from public.discount_codes")


def discount(db, target_id: str = "pack-standard", amount: int = 10, **rule) -> None:
    cols = ["target_type", "target_id", "discount_type", "amount", *rule]
    db.execute(
        f"insert into public.plan_discounts ({', '.join(cols)}) values ({', '.join(['%s'] * len(cols))})",
        ("pack", target_id, "percent", amount, *rule.values()),
    )


def mine(db, user: str | None) -> list[tuple]:
    sql = "select target_id, amount from public.my_plan_discounts() order by amount"
    if user:
        return [(t, int(a)) for t, a in as_user(db, user, sql)]
    with db.transaction():
        db.execute("set local role anon")
        return [(t, int(a)) for t, a in db.execute(sql).fetchall()]


def email(db, user: str) -> str:
    return db.execute("select email from public.profiles where id = %s", (user,)).fetchone()[0]


def test_signed_out_sees_only_discounts_open_to_everyone(db):
    user = make_user(db)
    discount(db, amount=10)
    discount(db, amount=20, allowed_emails=[email(db, user)])
    discount(db, amount=30, new_customers_only=True)
    assert mine(db, None) == [("pack-standard", 10)]


def test_listed_emails_match_ignoring_case(db):
    user, other = make_user(db), make_user(db)
    discount(db, amount=20, allowed_emails=[email(db, user).upper()])
    assert mine(db, user) == [("pack-standard", 20)]
    assert mine(db, other) == []


def test_signup_window(db):
    user = make_user(db)
    db.execute("update public.profiles set created_at = '2026-09-15' where id = %s", (user,))
    discount(db, amount=10, signup_from="2026-09-01", signup_to="2026-09-30")
    discount(db, amount=20, signup_from="2026-09-16")
    discount(db, amount=30, signup_to="2026-09-14")
    assert mine(db, user) == [("pack-standard", 10)]


def test_new_customers_only_ends_with_a_paid_order(db):
    user = make_user(db)
    discount(db, amount=30, new_customers_only=True)
    make_order(db, user, status="pending")
    assert mine(db, user) == [("pack-standard", 30)]
    make_order(db, user, status="success")
    assert mine(db, user) == []


def test_inactive_or_out_of_schedule_are_left_out(db):
    user = make_user(db)
    discount(db, amount=10, active=False)
    discount(db, amount=20, starts_at="2999-01-01")
    discount(db, amount=30, ends_at="2000-01-01")
    assert mine(db, user) == []


def test_plan_discounts_table_is_admin_only(db):
    admin, user = make_user(db, admin=True), make_user(db)
    discount(db, allowed_emails=["secret@example.com"])
    assert as_user(db, user, "select count(*) from public.plan_discounts")[0][0] == 0
    assert as_user(db, admin, "select count(*) from public.plan_discounts")[0][0] == 1


def test_audience_check_is_not_callable_by_users(db):
    user = make_user(db)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_user(db, user, "select public.discount_audience_ok(%s, null, null, null, true)", (user,))


def test_redeem_rpc_checks_the_audience(db):
    user = make_user(db)
    db.execute(
        "insert into public.discount_codes (code, discount_type, amount, allowed_emails)"
        " values ('VIP', 'percent', 10, array['vip@example.com'])"
    )
    with pytest.raises(psycopg.errors.RaiseException, match="isn't available"):
        as_user(db, user, "select * from public.redeem_discount_code('vip')")
