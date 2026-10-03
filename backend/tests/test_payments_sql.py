"""
Database tests for the SePay payment functions in
supabase/migrations/20261004000000_sepay_payments.sql.

These run every migration (plus supabase/seed.sql) against a throwaway local
Postgres from the `pgserver` package, with small stand-ins for the parts of
Supabase the migrations touch (auth schema, storage schema, API roles, and
Supabase's default grants). They are skipped when pgserver or psycopg isn't
installed:

    pip install pgserver "psycopg[binary]" pytest
    pytest backend/tests/test_payments_sql.py
"""
from __future__ import annotations

import uuid
from datetime import timedelta
from pathlib import Path

import pytest

pgserver = pytest.importorskip("pgserver")
psycopg = pytest.importorskip("psycopg")
from psycopg.types.json import Jsonb  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
MIGRATIONS = sorted((REPO / "supabase" / "migrations").glob("*.sql"))
SEED = REPO / "supabase" / "seed.sql"

SUPABASE_STUB = """
create schema auth;
create schema storage;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
create table storage.buckets (id text primary key, name text, public boolean,
  file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as
  $$ select string_to_array(name, '/') $$;
grant usage on schema public, auth, storage to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
"""


@pytest.fixture(scope="module")
def db(tmp_path_factory):
    server = pgserver.get_server(str(tmp_path_factory.mktemp("pg")), cleanup_mode="stop")
    with psycopg.connect(server.get_uri(), autocommit=True) as conn:
        conn.execute(SUPABASE_STUB)
        for migration in MIGRATIONS:
            conn.execute(migration.read_text())
        conn.execute(SEED.read_text())
        yield conn
    server.cleanup()


# --- helpers --------------------------------------------------------------


def make_user(db, *, admin: bool = False) -> str:
    uid = str(uuid.uuid4())
    db.execute("insert into auth.users (id, email) values (%s, %s)", (uid, f"{uid[:8]}@example.com"))
    if admin:
        db.execute("update public.profiles set role = 'admin' where id = %s", (uid,))
    return uid


def make_order(db, user_id: str, *, code: str | None = None, amount: int = 59000, kind: str = "pack",
               pack_id: str = "pack-standard", quantity: int = 3, plan_tier: str | None = None,
               billing_cycle: str | None = None, status: str = "pending", discount_code_id=None) -> tuple[str, str]:
    code = code or "ETM" + uuid.uuid4().hex[:8].upper()
    row = db.execute(
        """insert into public.checkout_events
             (user_id, kind, plan_tier, billing_cycle, pack_id, quantity, amount, list_amount,
              payment_method, status, payment_code, discount_code_id)
           values (%s, %s, %s, %s, %s, %s, %s, %s, 'sepay', %s, %s, %s) returning id""",
        (user_id, kind, plan_tier, billing_cycle, pack_id if kind == "pack" else None,
         quantity if kind == "pack" else 1, amount, amount, status, code, discount_code_id),
    ).fetchone()
    return str(row[0]), code


def webhook(db, *, sepay_id=None, amount: int = 59000, code: str | None = None, transfer_type: str = "in"):
    payload = {
        "id": str(sepay_id or uuid.uuid4().int % 10**9),
        "gateway": "TPBank",
        "account_number": "00004634438",
        "transfer_type": transfer_type,
        "amount": amount,
        "content": f"{code or 'no code'} chuyen tien",
        "reference_code": "FT123",
        "description": "",
        "payment_code": code,
        "transaction_date": "2026-10-04T10:15:00+07:00",
        "raw": {"id": sepay_id},
    }
    return db.execute("select public.record_sepay_transaction(%s)", (Jsonb(payload),)).fetchone()[0]


def profile(db, user_id: str) -> dict:
    cur = db.execute(
        "select plan_tier, billing_cycle, standard_credits, premium_credits from public.profiles where id = %s",
        (user_id,),
    )
    cols = [c.name for c in cur.description]
    return dict(zip(cols, cur.fetchone()))


def order(db, event_id: str) -> dict:
    cur = db.execute("select * from public.checkout_events where id = %s", (event_id,))
    cols = [c.name for c in cur.description]
    return dict(zip(cols, cur.fetchone()))


def tx(db, tx_id: str) -> dict:
    cur = db.execute("select * from public.payment_transactions where id = %s", (tx_id,))
    cols = [c.name for c in cur.description]
    return dict(zip(cols, cur.fetchone()))


def as_user(db, user_id: str, sql: str, params=()):
    """Run one statement as an authenticated PostgREST caller."""
    with db.transaction():
        db.execute("set local role authenticated")
        db.execute("select set_config('request.jwt.claim.sub', %s, true)", (user_id,))
        db.execute("select set_config('request.jwt.claim.role', 'authenticated', true)")
        return db.execute(sql, params).fetchall()


# --- webhook settlement ---------------------------------------------------


def test_matching_transfer_grants_pack_credits_once(db):
    uid = make_user(db)
    event_id, code = make_order(db, uid, amount=59000, quantity=3)

    result = webhook(db, sepay_id=1001, amount=59000, code=code)
    assert result["status"] == "matched" and result["duplicate"] is False
    assert result["checkout_event_id"] == event_id
    assert profile(db, uid)["standard_credits"] == 3  # 1 check per pack x 3

    paid = order(db, event_id)
    assert paid["status"] == "success"
    assert paid["paid_amount"] == 59000
    assert paid["paid_at"] is not None

    # SePay retries: same id must not grant again.
    again = webhook(db, sepay_id=1001, amount=59000, code=code)
    assert again["duplicate"] is True and again["status"] == "matched"
    assert profile(db, uid)["standard_credits"] == 3
    assert db.execute(
        "select count(*) from public.payment_transactions where provider_transaction_id = '1001'"
    ).fetchone()[0] == 1


def test_plan_order_sets_plan(db):
    uid = make_user(db)
    event_id, code = make_order(db, uid, kind="plan", plan_tier="professional", billing_cycle="annual", amount=2990000)
    assert webhook(db, amount=2990000, code=code)["status"] == "matched"
    p = profile(db, uid)
    assert p["plan_tier"] == "professional" and p["billing_cycle"] == "annual"


def test_premium_pack_tops_up_premium_balance(db):
    uid = make_user(db)
    _, code = make_order(db, uid, pack_id="pack-premium", quantity=2, amount=58000)
    webhook(db, amount=58000, code=code)
    assert profile(db, uid)["premium_credits"] == 2
    assert profile(db, uid)["standard_credits"] == 0


def test_underpaid_transfer_grants_nothing(db):
    uid = make_user(db)
    event_id, code = make_order(db, uid, amount=59000)
    result = webhook(db, amount=50000, code=code)
    assert result["status"] == "underpaid"
    assert order(db, event_id)["status"] == "pending"
    assert profile(db, uid)["standard_credits"] == 0
    assert "Expected 59000, received 50000" in tx(db, result["transaction_id"])["note"]


def test_overpaid_transfer_is_matched_and_noted(db):
    uid = make_user(db)
    _, code = make_order(db, uid, amount=59000)
    result = webhook(db, amount=60000, code=code)
    assert result["status"] == "matched"
    assert tx(db, result["transaction_id"])["note"] == "Overpaid by 1000."


def test_unknown_or_missing_code_is_unmatched(db):
    assert webhook(db, code="ETMNOSUCHX1")["status"] == "unmatched"
    assert webhook(db, code=None)["status"] == "unmatched"


def test_outgoing_transfer_is_ignored(db):
    uid = make_user(db)
    event_id, code = make_order(db, uid)
    assert webhook(db, code=code, transfer_type="out")["status"] == "ignored"
    assert order(db, event_id)["status"] == "pending"


def test_second_payment_for_paid_order_is_duplicate(db):
    uid = make_user(db)
    _, code = make_order(db, uid, quantity=1, amount=19000)
    assert webhook(db, amount=19000, code=code)["status"] == "matched"
    assert webhook(db, amount=19000, code=code)["status"] == "duplicate"
    assert profile(db, uid)["standard_credits"] == 1


def test_late_payment_for_cancelled_order_is_honoured(db):
    uid = make_user(db)
    event_id, code = make_order(db, uid, quantity=1, amount=19000, status="cancelled")
    assert webhook(db, amount=19000, code=code)["status"] == "matched"
    assert order(db, event_id)["status"] == "success"


def test_payment_for_declined_order_needs_review(db):
    uid = make_user(db)
    event_id, code = make_order(db, uid, status="declined")
    assert webhook(db, code=code)["status"] == "review"
    assert profile(db, uid)["standard_credits"] == 0


def test_code_match_is_case_insensitive(db):
    uid = make_user(db)
    _, code = make_order(db, uid, quantity=1, amount=19000)
    assert webhook(db, amount=19000, code=code.lower())["status"] == "matched"


def test_discount_code_is_used_up_when_paid(db):
    code_id = db.execute(
        "insert into public.discount_codes (code, discount_type, amount) values ('SPRING', 'percent', 10) returning id"
    ).fetchone()[0]
    uid = make_user(db)
    _, code = make_order(db, uid, quantity=1, amount=17100, discount_code_id=code_id)
    webhook(db, amount=17100, code=code)
    assert db.execute("select redemption_count from public.discount_codes where id = %s", (code_id,)).fetchone()[0] == 1
    assert db.execute(
        "select count(*) from public.discount_code_redemptions where code_id = %s and user_id = %s", (code_id, uid)
    ).fetchone()[0] == 1


def test_free_order_completes_without_transfer(db):
    uid = make_user(db)
    event_id, _ = make_order(db, uid, quantity=1, amount=0)
    assert db.execute("select public.complete_free_checkout(%s)", (event_id,)).fetchone()[0] is True
    assert order(db, event_id)["status"] == "success"
    assert profile(db, uid)["standard_credits"] == 1
    # Not twice, and never for an order that costs money.
    assert db.execute("select public.complete_free_checkout(%s)", (event_id,)).fetchone()[0] is False
    paid_id, _ = make_order(db, uid, quantity=1, amount=19000)
    assert db.execute("select public.complete_free_checkout(%s)", (paid_id,)).fetchone()[0] is False


# --- admin actions --------------------------------------------------------


def test_admin_links_unmatched_transfer_to_order(db):
    admin = make_user(db, admin=True)
    uid = make_user(db)
    event_id, _ = make_order(db, uid, quantity=2, amount=38000)
    stray = webhook(db, amount=38000, code=None)  # customer forgot the code

    rows = as_user(db, admin, "select public.admin_match_payment_transaction(%s, %s, %s)",
                   (stray["transaction_id"], event_id, "Customer sent proof by email"))
    assert rows[0][0] is True
    assert profile(db, uid)["standard_credits"] == 2
    linked = tx(db, stray["transaction_id"])
    assert linked["status"] == "matched" and str(linked["checkout_event_id"]) == event_id
    assert str(linked["resolved_by"]) == admin
    assert order(db, event_id)["paid_amount"] == 38000

    # Already settled: can't be linked again.
    other_id, _ = make_order(db, uid, quantity=1, amount=19000)
    with pytest.raises(psycopg.errors.RaiseException, match="already settled"):
        as_user(db, admin, "select public.admin_match_payment_transaction(%s, %s)", (stray["transaction_id"], other_id))


def test_admin_cannot_link_to_paid_order(db):
    admin = make_user(db, admin=True)
    uid = make_user(db)
    _, code = make_order(db, uid, quantity=1, amount=19000)
    paid_event = webhook(db, amount=19000, code=code)["checkout_event_id"]
    stray = webhook(db, amount=19000, code=None)
    with pytest.raises(psycopg.errors.RaiseException, match="already paid"):
        as_user(db, admin, "select public.admin_match_payment_transaction(%s, %s)", (stray["transaction_id"], paid_event))


def test_admin_resolve_requires_note_and_open_transaction(db):
    admin = make_user(db, admin=True)
    stray = webhook(db, amount=5000, code=None)
    with pytest.raises(psycopg.errors.RaiseException, match="Add a note"):
        as_user(db, admin, "select public.admin_resolve_payment_transaction(%s, %s)", (stray["transaction_id"], " "))
    assert as_user(db, admin, "select public.admin_resolve_payment_transaction(%s, %s)",
                   (stray["transaction_id"], "Refunded"))[0][0] is True
    assert tx(db, stray["transaction_id"])["status"] == "resolved"
    # A second resolve finds nothing open.
    assert as_user(db, admin, "select public.admin_resolve_payment_transaction(%s, %s)",
                   (stray["transaction_id"], "again"))[0][0] is False


def test_non_admin_cannot_use_admin_functions(db):
    uid = make_user(db)
    event_id, _ = make_order(db, uid)
    stray = webhook(db, amount=59000, code=None)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_user(db, uid, "select public.admin_match_payment_transaction(%s, %s)", (stray["transaction_id"], event_id))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_user(db, uid, "select public.admin_resolve_payment_transaction(%s, %s)", (stray["transaction_id"], "x"))


def test_manual_approval_is_gone(db):
    assert db.execute("select to_regprocedure('public.approve_purchase_request(uuid, text)')").fetchone()[0] is None


# --- what clients may not do ----------------------------------------------


def test_users_cannot_create_orders_or_call_service_functions(db):
    uid = make_user(db)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_user(db, uid, """insert into public.checkout_events (user_id, kind, pack_id, amount, status, payment_code)
                            values (%s, 'pack', 'pack-standard', 1, 'pending', 'ETMCHEAP0001') returning id""", (uid,))
    for sql, params in [
        ("select public.record_sepay_transaction(%s)", (Jsonb({"id": "1", "amount": 1, "transfer_type": "in"}),)),
        ("select public.complete_free_checkout(%s)", (str(uuid.uuid4()),)),
    ]:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_user(db, uid, sql, params)


def test_users_cannot_read_the_ledger_but_admins_can(db):
    admin = make_user(db, admin=True)
    uid = make_user(db)
    webhook(db, amount=1000, code=None)
    assert as_user(db, uid, "select count(*) from public.payment_transactions")[0][0] == 0
    assert as_user(db, admin, "select count(*) from public.payment_transactions")[0][0] > 0
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_user(db, admin, "update public.payment_transactions set status = 'resolved'")


# --- subscription terms (20261005000000_plan_expiry.sql) -------------------


def plan_state(db, user_id: str) -> dict:
    cur = db.execute(
        """select plan_tier, billing_cycle, plan_expires_at, checks_used_this_period,
                  plan_expires_at - now() as remaining
           from public.profiles where id = %s""",
        (user_id,),
    )
    cols = [c.name for c in cur.description]
    return dict(zip(cols, cur.fetchone()))


def buy_plan(db, user_id: str, tier: str = "professional", cycle: str = "monthly") -> None:
    _, code = make_order(db, user_id, kind="plan", plan_tier=tier, billing_cycle=cycle, amount=1000)
    assert webhook(db, amount=1000, code=code)["status"] == "matched"


def test_first_plan_purchase_starts_a_term(db):
    uid = make_user(db)
    buy_plan(db, uid, cycle="monthly")
    s = plan_state(db, uid)
    assert s["plan_tier"] == "professional" and s["billing_cycle"] == "monthly"
    assert 27 <= s["remaining"].days <= 31

    uid2 = make_user(db)
    buy_plan(db, uid2, cycle="annual")
    assert 364 <= plan_state(db, uid2)["remaining"].days <= 366


def test_renewing_the_same_plan_adds_to_the_end_and_keeps_usage(db):
    uid = make_user(db)
    buy_plan(db, uid, cycle="monthly")
    db.execute("update public.profiles set checks_used_this_period = 4 where id = %s", (uid,))
    first_end = plan_state(db, uid)["plan_expires_at"]

    buy_plan(db, uid, cycle="annual")
    s = plan_state(db, uid)
    assert s["plan_expires_at"] - first_end > timedelta(days=364)
    assert s["billing_cycle"] == "annual"
    assert s["checks_used_this_period"] == 4


def test_switching_plans_starts_fresh(db):
    uid = make_user(db)
    buy_plan(db, uid, tier="student", cycle="annual")
    db.execute("update public.profiles set checks_used_this_period = 3 where id = %s", (uid,))
    buy_plan(db, uid, tier="professional", cycle="monthly")
    s = plan_state(db, uid)
    assert s["plan_tier"] == "professional" and s["checks_used_this_period"] == 0
    assert 27 <= s["remaining"].days <= 31


def test_buying_after_the_term_lapsed_starts_fresh(db):
    uid = make_user(db)
    buy_plan(db, uid)
    db.execute("update public.profiles set plan_expires_at = now() - interval '2 days' where id = %s", (uid,))
    buy_plan(db, uid)
    assert 27 <= plan_state(db, uid)["remaining"].days <= 31


def test_lapsed_plans_drop_to_free(db):
    lapsed, active, comped = make_user(db), make_user(db), make_user(db)
    for uid in (lapsed, active):
        buy_plan(db, uid)
    db.execute("update public.profiles set plan_expires_at = now() - interval '1 minute' where id = %s", (lapsed,))
    db.execute("update public.profiles set plan_tier = 'professional', plan_expires_at = null where id = %s", (comped,))

    assert db.execute("select public.expire_lapsed_plans()").fetchone()[0] >= 1
    assert plan_state(db, lapsed)["plan_tier"] == "free"
    assert plan_state(db, lapsed)["plan_expires_at"] is not None  # kept: "ended on …"
    assert plan_state(db, active)["plan_tier"] == "professional"
    assert plan_state(db, comped)["plan_tier"] == "professional"  # no end date


def test_users_cannot_extend_their_own_term(db):
    uid = make_user(db)
    buy_plan(db, uid)
    with pytest.raises(psycopg.errors.RaiseException, match="Not allowed"):
        as_user(db, uid, "update public.profiles set plan_expires_at = now() + interval '10 years' where id = %s returning id", (uid,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_user(db, uid, "select public.expire_lapsed_plans()")


def test_notification_log_is_backend_only(db):
    admin, uid = make_user(db, admin=True), make_user(db)
    db.execute("insert into public.notification_log (kind, ref) values ('plan_ended', %s)", (uid,))
    assert as_user(db, uid, "select count(*) from public.notification_log")[0][0] == 0
    assert as_user(db, admin, "select count(*) from public.notification_log")[0][0] >= 1
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_user(db, uid, "insert into public.notification_log (kind, ref) values ('x', 'y')")
    with pytest.raises(psycopg.errors.UniqueViolation):
        db.execute("insert into public.notification_log (kind, ref) values ('plan_ended', %s)", (uid,))
