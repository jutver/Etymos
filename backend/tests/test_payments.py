"""
Tests for backend/api/payments.py: pricing, orders and the SePay webhook.
Supabase is replaced by an in-memory fake; the settlement SQL itself
(record_sepay_transaction) is covered by test_payments_sql.py against a
real Postgres. Like test_recovery_email.py, the router is mounted on a small
standalone app rather than importing app.py and its ML pipeline.
"""
from __future__ import annotations

import itertools
import re
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from slowapi.middleware import SlowAPIMiddleware

import notifications
import payments
import rate_limit
from auth import AuthedUser, verify_supabase_jwt

API_KEY = "test-sepay-key"


# --- in-memory stand-in for the supabase-py query builder -----------------


class UniqueViolation(Exception):
    pass


class _Query:
    def __init__(self, db: "FakeDB", table: str):
        self.db, self.table = db, table
        self.filters: list = []
        self.op, self.payload = "select", None
        self.order_by = None

    def select(self, *_):
        return self

    def limit(self, *_):
        return self

    def order(self, col, desc=False):
        self.order_by = (col, desc)
        return self

    def eq(self, col, val):
        self.filters.append(lambda r, c=col, v=val: r.get(c) == v)
        return self

    def ilike(self, col, pattern):
        plain = re.sub(r"\\(.)", r"\1", pattern)
        self.filters.append(lambda r, c=col, p=plain: str(r.get(c) or "").lower() == p.lower())
        return self

    def insert(self, payload):
        self.op, self.payload = "insert", payload
        return self

    def update(self, payload):
        self.op, self.payload = "update", payload
        return self

    def execute(self):
        rows = self.db.tables.setdefault(self.table, [])
        match = [r for r in rows if all(f(r) for f in self.filters)]
        if self.op == "select":
            if self.order_by:
                col, desc = self.order_by
                match.sort(key=lambda r: r.get(col) or "", reverse=desc)
            return SimpleNamespace(data=[dict(r) for r in match])
        if self.op == "insert":
            if self.table == "checkout_events":
                if self.db.code_collisions:
                    self.db.code_collisions -= 1
                    raise UniqueViolation('duplicate key value violates unique constraint "checkout_events_payment_code_key"')
                row = {
                    "id": f"order-{next(self.db.ids)}",
                    "created_at": f"2026-10-04T03:00:{next(self.db.ids):02d}+00:00",
                    "paid_at": None,
                    **self.payload,
                }
            else:
                row = dict(self.payload)
            rows.append(row)
            return SimpleNamespace(data=[dict(row)])
        if self.op == "update":
            for r in match:
                r.update(self.payload)
            return SimpleNamespace(data=[dict(r) for r in match])
        raise AssertionError(self.op)


class FakeDB:
    def __init__(self):
        self.ids = itertools.count(1)
        self.code_collisions = 0
        self.rpc_calls: list = []
        self.rpc_error: Exception | None = None
        self.rpc_result: dict = {"status": "matched", "duplicate": False}
        self.tables: dict = {
            "plan_definitions": [
                {"id": "student", "price_monthly": 69000, "price_annual": 690000, "requires_verification": True},
                {"id": "professional", "price_monthly": 299000, "price_annual": 2990000, "requires_verification": False},
            ],
            "credit_packs": [
                {"id": "pack-standard", "price": 19000, "checks": 1},
                {"id": "pack-premium", "price": 29000, "checks": 1},
            ],
            "profiles": [
                {"id": "user-1", "student_verified": False},
                {"id": "user-2", "student_verified": True},
            ],
            "plan_discounts": [],
            "discount_codes": [],
            "discount_code_redemptions": [],
            "checkout_events": [],
        }

    def table(self, name):
        return _Query(self, name)

    def rpc(self, name, params):
        db = self

        class _Call:
            def execute(self_inner):
                db.rpc_calls.append((name, params))
                if db.rpc_error:
                    raise db.rpc_error
                if name == "complete_free_checkout":
                    for r in db.tables["checkout_events"]:
                        if r["id"] == params["p_event_id"]:
                            r.update(status="success", paid_amount=0, paid_at="2026-10-04T03:00:00+00:00")
                    return SimpleNamespace(data=True)
                return SimpleNamespace(data=db.rpc_result)

        return _Call()


@pytest.fixture
def env(monkeypatch):
    db = FakeDB()
    monkeypatch.setattr(payments, "get_client", lambda: db)
    monkeypatch.setenv("SEPAY_BANK", "TPBank")
    monkeypatch.setenv("SEPAY_ACCOUNT_NUMBER", "00004634438")
    monkeypatch.setenv("SEPAY_ACCOUNT_NAME", "NGUYEN VAN A")
    monkeypatch.setenv("SEPAY_WEBHOOK_API_KEY", API_KEY)
    monkeypatch.delenv("PAYMENT_CODE_PREFIX", raising=False)

    current = {"user": AuthedUser(user_id="user-1", email="owner@example.com", role="user", is_admin=False)}
    app = FastAPI()
    app.state.limiter = rate_limit.limiter
    app.add_middleware(SlowAPIMiddleware)
    app.include_router(payments.router)
    app.dependency_overrides[verify_supabase_jwt] = lambda: current["user"]
    rate_limit.limiter.reset()
    return SimpleNamespace(client=TestClient(app), db=db, current=current)


PACK = {"kind": "pack", "pack_id": "pack-standard", "quantity": 3}
PRO_ANNUAL = {"kind": "plan", "plan_tier": "professional", "billing_cycle": "annual"}


def _iso(delta: timedelta) -> str:
    return (datetime.now(timezone.utc) + delta).isoformat()


# --- payment codes ---------------------------------------------------------


def test_payment_codes_are_unique_and_unambiguous():
    codes = {payments.new_payment_code() for _ in range(500)}
    assert len(codes) == 500
    for code in codes:
        assert re.fullmatch(r"ETM[A-HJ-NP-Z2-9]{8}", code)


def test_extract_payment_code_from_content_or_sepay_code():
    assert payments.extract_payment_code(None, "ETM7K2QF9XA chuyen tien") == "ETM7K2QF9XA"
    # Banks prepend/append text and may change case.
    assert payments.extract_payment_code(None, "MBVCB.123.etm7k2qf9xa.CT tu 0123") == "ETM7K2QF9XA"
    assert payments.extract_payment_code("ETMABCDEFGH", "something else") == "ETMABCDEFGH"
    assert payments.extract_payment_code(None, "chuyen tien mua goi") is None
    assert payments.extract_payment_code(None, "ETM7K2Q") is None  # too short
    assert payments.extract_payment_code(None, None) is None


def test_payment_code_prefix_is_configurable(monkeypatch):
    monkeypatch.setenv("PAYMENT_CODE_PREFIX", "abc-1")
    assert payments.new_payment_code().startswith("ABC")
    assert payments.extract_payment_code(None, "abcHJKMNPQR") == "ABCHJKMNPQR"


def test_qr_url_carries_account_amount_and_code():
    account = payments.BankAccount("TPBank", "00004634438", "NGUYEN VAN A")
    url = urlparse(payments.qr_url(account, 57000, "ETM7K2QF9XA"))
    assert url.netloc == "qr.sepay.vn" and url.path == "/img"
    q = parse_qs(url.query)
    assert q["acc"] == ["00004634438"] and q["bank"] == ["TPBank"]
    assert q["amount"] == ["57000"] and q["des"] == ["ETM7K2QF9XA"]


# --- pricing ---------------------------------------------------------------


def test_quote_pack_multiplies_by_quantity(env):
    r = env.client.post("/api/payments/quote", json=PACK)
    assert r.json() == {"list_amount": 57000, "amount": 57000, "discount": None}


def test_quote_plan_uses_billing_cycle(env):
    assert env.client.post("/api/payments/quote", json=PRO_ANNUAL).json()["amount"] == 2990000
    monthly = {**PRO_ANNUAL, "billing_cycle": "monthly"}
    assert env.client.post("/api/payments/quote", json=monthly).json()["amount"] == 299000


def test_quote_ignores_quantity_for_plans(env):
    assert env.client.post("/api/payments/quote", json={**PRO_ANNUAL, "quantity": 5}).json()["amount"] == 2990000


def test_quote_rejects_incomplete_or_out_of_range_items(env):
    assert env.client.post("/api/payments/quote", json={"kind": "plan", "plan_tier": "professional"}).status_code == 422
    assert env.client.post("/api/payments/quote", json={"kind": "pack"}).status_code == 422
    assert env.client.post("/api/payments/quote", json={**PACK, "quantity": 21}).status_code == 422
    assert env.client.post("/api/payments/quote", json={"kind": "plan", "plan_tier": "free", "billing_cycle": "monthly"}).status_code == 422


def test_student_plan_requires_verification(env):
    student = {"kind": "plan", "plan_tier": "student", "billing_cycle": "monthly"}
    r = env.client.post("/api/payments/quote", json=student)
    assert r.status_code == 403 and r.json()["detail"] == "verification_required"
    env.current["user"] = AuthedUser(user_id="user-2", email="s@example.com", role="user", is_admin=False)
    assert env.client.post("/api/payments/quote", json=student).json()["amount"] == 69000


def test_quote_applies_best_active_automatic_discount(env):
    env.db.tables["plan_discounts"] += [
        {"target_type": "pack", "target_id": "pack-standard", "discount_type": "percent", "amount": 10, "active": True},
        {"target_type": "pack", "target_id": "pack-standard", "discount_type": "fixed", "amount": 10000, "active": True},
        # Better, but not active / not started / ended / other item:
        {"target_type": "pack", "target_id": "pack-standard", "discount_type": "percent", "amount": 90, "active": False},
        {"target_type": "pack", "target_id": "pack-standard", "discount_type": "percent", "amount": 80, "active": True,
         "starts_at": _iso(timedelta(days=1))},
        {"target_type": "pack", "target_id": "pack-standard", "discount_type": "percent", "amount": 70, "active": True,
         "ends_at": _iso(-timedelta(days=1))},
        {"target_type": "pack", "target_id": "pack-premium", "discount_type": "percent", "amount": 60, "active": True},
    ]
    r = env.client.post("/api/payments/quote", json=PACK).json()
    assert r["list_amount"] == 57000 and r["amount"] == 47000
    assert r["discount"] == {"source": "auto", "type": "fixed", "value": 10000.0}


def test_discount_code_overrides_automatic_discount_without_being_used(env):
    env.db.tables["plan_discounts"].append(
        {"target_type": "pack", "target_id": "pack-standard", "discount_type": "percent", "amount": 50, "active": True}
    )
    env.db.tables["discount_codes"].append(
        {"id": "dc-1", "code": "Spring", "discount_type": "percent", "amount": 10, "active": True,
         "max_redemptions": 5, "redemption_count": 0}
    )
    r = env.client.post("/api/payments/quote", json={**PACK, "discount_code": " spring "}).json()
    assert r["amount"] == 51300 and r["discount"]["source"] == "code"
    assert env.db.tables["discount_codes"][0]["redemption_count"] == 0
    assert env.db.tables["discount_code_redemptions"] == []


@pytest.mark.parametrize(
    "row,detail",
    [
        (None, "discount_invalid"),
        ({"active": False}, "discount_inactive"),
        ({"starts_at": _iso(timedelta(days=1))}, "discount_not_started"),
        ({"ends_at": _iso(-timedelta(days=1))}, "discount_expired"),
        ({"max_redemptions": 2, "redemption_count": 2}, "discount_limit_reached"),
    ],
)
def test_discount_code_errors(env, row, detail):
    if row is not None:
        env.db.tables["discount_codes"].append(
            {"id": "dc-1", "code": "SPRING", "discount_type": "percent", "amount": 10, "active": True, **row}
        )
    r = env.client.post("/api/payments/quote", json={**PACK, "discount_code": "SPRING"})
    assert r.status_code == 400 and r.json()["detail"] == detail


def test_discount_code_used_once_per_user(env):
    env.db.tables["discount_codes"].append(
        {"id": "dc-1", "code": "SPRING", "discount_type": "percent", "amount": 10, "active": True}
    )
    env.db.tables["discount_code_redemptions"].append({"id": "r1", "code_id": "dc-1", "user_id": "user-1"})
    r = env.client.post("/api/payments/quote", json={**PACK, "discount_code": "SPRING"})
    assert r.json()["detail"] == "discount_already_used"


def test_discount_code_wildcards_are_literal(env):
    env.db.tables["discount_codes"].append(
        {"id": "dc-1", "code": "SPRING", "discount_type": "percent", "amount": 10, "active": True}
    )
    r = env.client.post("/api/payments/quote", json={**PACK, "discount_code": "SPR%"})
    assert r.json()["detail"] == "discount_invalid"


def test_fixed_discount_never_goes_below_zero():
    assert payments._apply(19000, "fixed", 50000) == 0
    assert payments._apply(19000, "percent", 150) == 0
    assert payments._apply(19999, "percent", 10) == 17999


# --- orders ----------------------------------------------------------------


def test_create_order_returns_transfer_details(env):
    r = env.client.post("/api/payments/orders", json=PACK)
    assert r.status_code == 200
    order = r.json()
    assert order["status"] == "pending" and order["amount"] == 57000 and order["quantity"] == 3
    assert re.fullmatch(r"ETM[A-HJ-NP-Z2-9]{8}", order["payment_code"])
    transfer = order["transfer"]
    assert transfer["content"] == order["payment_code"] and transfer["amount"] == 57000
    assert transfer["bank"] == "TPBank" and transfer["account_number"] == "00004634438"
    assert "qr.sepay.vn" in transfer["qr_url"]

    stored = env.db.tables["checkout_events"][0]
    assert stored["user_id"] == "user-1" and stored["payment_method"] == "sepay"
    assert stored["amount"] == 57000 and stored["list_amount"] == 57000
    expires = payments._parse_ts(stored["expires_at"])
    assert timedelta(minutes=29) < expires - datetime.now(timezone.utc) <= timedelta(minutes=30)


def test_order_price_comes_from_server_not_client(env):
    r = env.client.post("/api/payments/orders", json={**PACK, "amount": 1, "list_amount": 1})
    assert r.json()["amount"] == 57000


def test_order_records_discount_code(env):
    env.db.tables["discount_codes"].append(
        {"id": "dc-1", "code": "SPRING", "discount_type": "fixed", "amount": 7000, "active": True}
    )
    env.client.post("/api/payments/orders", json={**PACK, "discount_code": "spring"})
    stored = env.db.tables["checkout_events"][0]
    assert stored["discount_code_id"] == "dc-1" and stored["amount"] == 50000


def test_new_order_cancels_previous_unpaid_sepay_order_only(env):
    env.db.tables["checkout_events"] += [
        {"id": "legacy", "user_id": "user-1", "status": "pending", "payment_method": "vnpay", "kind": "pack"},
        {"id": "other-user", "user_id": "user-9", "status": "pending", "payment_method": "sepay", "kind": "pack"},
    ]
    first = env.client.post("/api/payments/orders", json=PACK).json()
    second = env.client.post("/api/payments/orders", json=PRO_ANNUAL).json()
    by_id = {r["id"]: r for r in env.db.tables["checkout_events"]}
    assert by_id[first["id"]]["status"] == "cancelled"
    assert by_id[second["id"]]["status"] == "pending"
    assert by_id["legacy"]["status"] == "pending"
    assert by_id["other-user"]["status"] == "pending"


def test_payment_code_collision_is_retried(env):
    env.db.code_collisions = 2
    assert env.client.post("/api/payments/orders", json=PACK).status_code == 200
    assert len(env.db.tables["checkout_events"]) == 1


def test_free_order_completes_immediately(env):
    env.db.tables["discount_codes"].append(
        {"id": "dc-1", "code": "FREE", "discount_type": "percent", "amount": 100, "active": True}
    )
    order = env.client.post("/api/payments/orders", json={**PACK, "discount_code": "FREE"}).json()
    assert order["status"] == "success" and order["amount"] == 0 and order["transfer"] is None
    assert env.db.rpc_calls == [("complete_free_checkout", {"p_event_id": order["id"]})]


def test_orders_need_bank_account_configured(env, monkeypatch):
    monkeypatch.delenv("SEPAY_ACCOUNT_NUMBER")
    r = env.client.post("/api/payments/orders", json=PACK)
    assert r.status_code == 503 and r.json()["detail"] == "payments_not_configured"


def test_get_order_only_for_its_owner(env):
    order = env.client.post("/api/payments/orders", json=PACK).json()
    assert env.client.get(f"/api/payments/orders/{order['id']}").json()["id"] == order["id"]
    env.current["user"] = AuthedUser(user_id="user-2", email="x@example.com", role="user", is_admin=False)
    assert env.client.get(f"/api/payments/orders/{order['id']}").status_code == 404
    assert env.client.post(f"/api/payments/orders/{order['id']}/cancel").status_code == 404


def test_paid_or_expired_order_has_no_transfer_details(env):
    order = env.client.post("/api/payments/orders", json=PACK).json()
    stored = env.db.tables["checkout_events"][0]
    stored["expires_at"] = _iso(-timedelta(minutes=1))
    assert env.client.get(f"/api/payments/orders/{order['id']}").json()["transfer"] is None
    stored.update(status="success", expires_at=_iso(timedelta(minutes=5)))
    assert env.client.get(f"/api/payments/orders/{order['id']}").json()["transfer"] is None


def test_active_order_is_latest_unexpired_pending(env):
    assert env.client.get("/api/payments/orders/active").json() == {"order": None}
    order = env.client.post("/api/payments/orders", json=PACK).json()
    assert env.client.get("/api/payments/orders/active").json()["order"]["id"] == order["id"]
    env.db.tables["checkout_events"][0]["expires_at"] = _iso(-timedelta(seconds=1))
    assert env.client.get("/api/payments/orders/active").json() == {"order": None}


def test_cancel_order(env):
    order = env.client.post("/api/payments/orders", json=PACK).json()
    r = env.client.post(f"/api/payments/orders/{order['id']}/cancel")
    assert r.json()["status"] == "cancelled" and r.json()["transfer"] is None
    again = env.client.post(f"/api/payments/orders/{order['id']}/cancel")
    assert again.status_code == 409 and again.json()["detail"] == "not_pending"


# --- SePay webhook ---------------------------------------------------------


def _sepay(**overrides):
    body = {
        "id": 92704,
        "gateway": "TPBank",
        "transactionDate": "2026-10-04 10:15:33",
        "accountNumber": "00004634438",
        "subAccount": None,
        "code": None,
        "content": "ETM7K2QF9XA chuyen tien",
        "transferType": "in",
        "transferAmount": 57000,
        "accumulated": 1057000,
        "referenceCode": "FT26277123456",
        "description": "BankAPINotify ETM7K2QF9XA chuyen tien",
    }
    body.update(overrides)
    return body


def _post_webhook(env, body, key=API_KEY):
    headers = {"Authorization": f"Apikey {key}"} if key is not None else {}
    return env.client.post("/api/payments/sepay/webhook", json=body, headers=headers)


def test_webhook_records_transfer_and_acknowledges(env):
    r = _post_webhook(env, _sepay())
    assert r.status_code == 200 and r.json() == {"success": True}
    name, params = env.db.rpc_calls[0]
    assert name == "record_sepay_transaction"
    tx = params["p_tx"]
    assert tx["id"] == "92704" and tx["amount"] == 57000 and tx["transfer_type"] == "in"
    assert tx["payment_code"] == "ETM7K2QF9XA" and tx["reference_code"] == "FT26277123456"
    assert tx["transaction_date"] == "2026-10-04T10:15:33+07:00"
    assert tx["raw"]["accumulated"] == 1057000


@pytest.mark.parametrize("key", [None, "wrong-key", ""])
def test_webhook_rejects_bad_api_key(env, key):
    assert _post_webhook(env, _sepay(), key=key).status_code == 401
    assert env.db.rpc_calls == []


def test_webhook_rejects_other_auth_schemes(env):
    r = env.client.post("/api/payments/sepay/webhook", json=_sepay(), headers={"Authorization": f"Bearer {API_KEY}"})
    assert r.status_code == 401


def test_webhook_refuses_when_key_not_configured(env, monkeypatch):
    monkeypatch.delenv("SEPAY_WEBHOOK_API_KEY")
    assert _post_webhook(env, _sepay(), key="anything").status_code == 503
    assert env.db.rpc_calls == []


def test_webhook_db_failure_returns_error_so_sepay_retries(env):
    env.db.rpc_error = RuntimeError("connection reset")
    r = _post_webhook(env, _sepay())
    assert r.status_code == 500 and "success" not in r.json()


def test_webhook_rejects_malformed_payload(env):
    assert _post_webhook(env, {"id": 1}).status_code == 422
    assert _post_webhook(env, _sepay(transferAmount=-5)).status_code == 422


def test_webhook_handles_missing_code_and_odd_dates(env):
    _post_webhook(env, _sepay(content="chuyen tien", transactionDate="not a date", transferType="OUT"))
    tx = env.db.rpc_calls[0][1]["p_tx"]
    assert tx["payment_code"] is None and tx["transaction_date"] is None and tx["transfer_type"] == "out"


def test_webhook_prefers_sepay_code_field(env):
    _post_webhook(env, _sepay(code="ETMHJKMNPQR", content="ETM7K2QF9XA"))
    assert env.db.rpc_calls[0][1]["p_tx"]["payment_code"] == "ETMHJKMNPQR"


def test_webhook_emails_receipt_or_admin_after_settling(env, monkeypatch):
    calls = []
    monkeypatch.setattr(notifications, "notify_payment_receipt", lambda oid: calls.append(("receipt", oid)))
    monkeypatch.setattr(notifications, "notify_admin_transfer", lambda tid: calls.append(("admin", tid)))

    env.db.rpc_result = {"status": "matched", "checkout_event_id": "order-7", "transaction_id": "tx-1", "duplicate": False}
    _post_webhook(env, _sepay())
    env.db.rpc_result = {"status": "underpaid", "checkout_event_id": "order-8", "transaction_id": "tx-2", "duplicate": False}
    _post_webhook(env, _sepay(id=2))
    env.db.rpc_result = {"status": "ignored", "checkout_event_id": None, "transaction_id": "tx-3", "duplicate": False}
    _post_webhook(env, _sepay(id=3, transferType="out"))
    assert calls == [("receipt", "order-7"), ("admin", "tx-2")]


def test_free_order_emails_a_receipt(env, monkeypatch):
    calls = []
    monkeypatch.setattr(notifications, "notify_payment_receipt", lambda oid: calls.append(oid))
    env.db.tables["discount_codes"].append(
        {"id": "dc-1", "code": "FREE", "discount_type": "percent", "amount": 100, "active": True}
    )
    order = env.client.post("/api/payments/orders", json={**PACK, "discount_code": "FREE"}).json()
    assert calls == [order["id"]]
