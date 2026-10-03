"""
payments.py
-----------
Plan and credit-pack purchases paid by bank transfer, confirmed by SePay.

SePay watches the shop's bank account and POSTs a webhook for every
transfer. Each order gets a unique payment code (e.g. ETM7K2QF9XA) that the
customer's transfer must carry; the VietQR we show fills it in for them.

Signed in (the web app's checkout):
  POST /api/payments/quote                 price an item (and discount code)
  POST /api/payments/orders                create an order -> QR + transfer details
  GET  /api/payments/orders/active         the caller's unpaid, unexpired order
  GET  /api/payments/orders/{id}           one of the caller's orders (polled)
  POST /api/payments/orders/{id}/cancel    abandon an unpaid order

SePay:
  POST /api/payments/sepay/webhook         "Authorization: Apikey <key>"

Prices are always computed here from plan_definitions / credit_packs /
plan_discounts / discount_codes — never taken from the browser — because a
matching transfer grants the order automatically.

Settlement happens in the database: record_sepay_transaction() (see
supabase/migrations/20261004000000_sepay_payments.sql) logs the transfer
once per SePay id, finds the order by code, checks the amount and grants
it in one transaction. A retried webhook is recorded once and never grants
twice. Transfers it can't settle stay in payment_transactions for an admin.
"""

# No `from __future__ import annotations`: slowapi wraps the limited routes,
# and FastAPI resolves string annotations against the wrapper's module, so
# the request-body models would silently turn into query parameters (422).
import hmac
import logging
import os
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator

from auth import AuthedUser, verify_supabase_jwt
from rate_limit import limiter
from supabase_client import get_client

logger = logging.getLogger(__name__)

router = APIRouter()

ORDERS = "checkout_events"
MAX_PACK_QUANTITY = 20
# Unambiguous characters only (no 0/O, 1/I), since people may type the code.
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 8
QR_BASE_URL = "https://qr.sepay.vn/img"
# Vietnam has no daylight saving; SePay reports bank times in local time.
VN_TZ = timezone(timedelta(hours=7))

RATE_LIMIT_PAYMENT_QUOTE = os.getenv("RATE_LIMIT_PAYMENT_QUOTE", "120/hour")
RATE_LIMIT_PAYMENT_ORDER = os.getenv("RATE_LIMIT_PAYMENT_ORDER", "30/hour")


def code_prefix() -> str:
    return re.sub(r"[^A-Z]", "", os.getenv("PAYMENT_CODE_PREFIX", "ETM").upper()) or "ETM"


def order_ttl() -> timedelta:
    return timedelta(minutes=int(os.getenv("PAYMENT_ORDER_TTL_MINUTES", "30")))


@dataclass(frozen=True)
class BankAccount:
    bank: str  # SePay/VietQR short name, e.g. "TPBank"
    account_number: str
    account_name: str


def bank_account() -> Optional[BankAccount]:
    bank = os.getenv("SEPAY_BANK", "").strip()
    number = os.getenv("SEPAY_ACCOUNT_NUMBER", "").strip()
    if not bank or not number:
        return None
    return BankAccount(bank, number, os.getenv("SEPAY_ACCOUNT_NAME", "").strip())


# --- payment codes ---------------------------------------------------------


def new_payment_code() -> str:
    return code_prefix() + "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def extract_payment_code(provider_code: Optional[str], content: Optional[str]) -> Optional[str]:
    """The order code in a transfer: SePay's own `code` field when it holds
    one of ours, else the first match in the transfer content. Banks and
    wallets often add text around it or change its case."""
    pattern = re.compile(rf"{code_prefix()}[{CODE_ALPHABET}]{{{CODE_LENGTH}}}")
    for text in (provider_code, content):
        match = pattern.search((text or "").upper())
        if match:
            return match.group(0)
    return None


def qr_url(account: BankAccount, amount: int, content: str) -> str:
    query = {"acc": account.account_number, "bank": account.bank, "amount": amount, "des": content, "template": "compact"}
    return f"{QR_BASE_URL}?{urlencode(query)}"


# --- helpers -----------------------------------------------------------------


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_ts(value: Optional[str]) -> Optional[datetime]:
    """Postgres timestamptz as returned by PostgREST (may end in 'Z' and
    carry any number of fractional digits, which Python 3.10 rejects)."""
    if not value:
        return None
    value = value.replace("Z", "+00:00")
    value = re.sub(r"\.(\d+)", lambda m: "." + (m.group(1) + "000000")[:6], value)
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _client():
    client = get_client()
    if client is None:
        raise HTTPException(status_code=503, detail="payments_not_configured")
    return client


def _first(res) -> Optional[dict]:
    return res.data[0] if res.data else None


# --- pricing -------------------------------------------------------------------


class ItemIn(BaseModel):
    kind: Literal["plan", "pack"]
    plan_tier: Optional[Literal["student", "professional"]] = None
    billing_cycle: Optional[Literal["monthly", "annual"]] = None
    pack_id: Optional[Literal["pack-standard", "pack-premium"]] = None
    quantity: int = Field(default=1, ge=1, le=MAX_PACK_QUANTITY)
    discount_code: Optional[str] = Field(default=None, max_length=64)

    @model_validator(mode="after")
    def _complete(self):
        if self.kind == "plan" and (self.plan_tier is None or self.billing_cycle is None):
            raise ValueError("A plan needs plan_tier and billing_cycle.")
        if self.kind == "pack" and self.pack_id is None:
            raise ValueError("A pack needs pack_id.")
        if self.kind == "plan":
            self.quantity = 1
        if self.discount_code is not None:
            self.discount_code = self.discount_code.strip() or None
        return self


@dataclass
class Quote:
    list_amount: int
    amount: int
    # {"source": "auto"|"code", "type": "percent"|"fixed", "value": float}
    discount: Optional[dict]
    discount_code_id: Optional[str]

    def public(self) -> dict:
        return {"list_amount": self.list_amount, "amount": self.amount, "discount": self.discount}


def _apply(price: int, discount_type: str, value: float) -> int:
    if discount_type == "percent":
        return max(0, round(price * (1 - float(value) / 100)))
    return max(0, round(price - float(value)))


def _in_window(row: dict, now: datetime) -> bool:
    starts, ends = _parse_ts(row.get("starts_at")), _parse_ts(row.get("ends_at"))
    return (starts is None or starts <= now) and (ends is None or ends >= now)


def _code_row(client, user_id: str, raw_code: str) -> dict:
    """The discount_codes row for a code the user typed, if they may use it.
    Same rules as the redeem_discount_code RPC, without using it up: a code
    is only spent when its order is paid."""
    escaped = re.sub(r"([%_\\])", r"\\\1", raw_code)
    row = _first(client.table("discount_codes").select("*").ilike("code", escaped).limit(1).execute())
    if row is None:
        raise HTTPException(status_code=400, detail="discount_invalid")
    now = _now()
    if not row.get("active"):
        raise HTTPException(status_code=400, detail="discount_inactive")
    starts, ends = _parse_ts(row.get("starts_at")), _parse_ts(row.get("ends_at"))
    if starts is not None and now < starts:
        raise HTTPException(status_code=400, detail="discount_not_started")
    if ends is not None and now > ends:
        raise HTTPException(status_code=400, detail="discount_expired")
    cap = row.get("max_redemptions")
    if cap is not None and int(row.get("redemption_count") or 0) >= int(cap):
        raise HTTPException(status_code=400, detail="discount_limit_reached")
    used = (
        client.table("discount_code_redemptions")
        .select("id")
        .eq("code_id", row["id"])
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    if used.data:
        raise HTTPException(status_code=400, detail="discount_already_used")
    return row


def quote_item(client, user_id: str, item: ItemIn) -> Quote:
    if item.kind == "plan":
        plan = _first(client.table("plan_definitions").select("*").eq("id", item.plan_tier).limit(1).execute())
        if plan is None:
            raise HTTPException(status_code=400, detail="unknown_item")
        if plan.get("requires_verification"):
            profile = _first(
                client.table("profiles").select("student_verified").eq("id", user_id).limit(1).execute()
            )
            if not (profile and profile.get("student_verified")):
                raise HTTPException(status_code=403, detail="verification_required")
        unit = plan["price_annual"] if item.billing_cycle == "annual" else plan["price_monthly"]
        target_type, target_id = "plan", item.plan_tier
    else:
        pack = _first(client.table("credit_packs").select("*").eq("id", item.pack_id).limit(1).execute())
        if pack is None:
            raise HTTPException(status_code=400, detail="unknown_item")
        unit = pack["price"]
        target_type, target_id = "pack", item.pack_id

    list_amount = round(float(unit) * item.quantity)
    if list_amount <= 0:
        raise HTTPException(status_code=400, detail="unknown_item")

    # A typed code replaces any automatic discount rather than stacking.
    if item.discount_code:
        code = _code_row(client, user_id, item.discount_code)
        return Quote(
            list_amount=list_amount,
            amount=_apply(list_amount, code["discount_type"], code["amount"]),
            discount={"source": "code", "type": code["discount_type"], "value": float(code["amount"])},
            discount_code_id=code["id"],
        )

    now = _now()
    rows = (
        client.table("plan_discounts")
        .select("*")
        .eq("target_type", target_type)
        .eq("target_id", target_id)
        .eq("active", True)
        .execute()
    ).data or []
    best: Optional[dict] = None
    for row in rows:
        if _in_window(row, now) and (
            best is None
            or _apply(list_amount, row["discount_type"], row["amount"])
            < _apply(list_amount, best["discount_type"], best["amount"])
        ):
            best = row
    if best is None:
        return Quote(list_amount, list_amount, None, None)
    return Quote(
        list_amount=list_amount,
        amount=_apply(list_amount, best["discount_type"], best["amount"]),
        discount={"source": "auto", "type": best["discount_type"], "value": float(best["amount"])},
        discount_code_id=None,
    )


# --- orders --------------------------------------------------------------------


def order_out(row: dict) -> dict:
    """The order as the web app sees it. Transfer details only while it can
    still be paid."""
    amount = round(float(row.get("amount") or 0))
    expires = _parse_ts(row.get("expires_at"))
    payable = row.get("status") == "pending" and amount > 0 and (expires is None or expires > _now())
    account = bank_account()
    transfer = None
    if payable and account and row.get("payment_code"):
        transfer = {
            "bank": account.bank,
            "account_number": account.account_number,
            "account_name": account.account_name,
            "amount": amount,
            "content": row["payment_code"],
            "qr_url": qr_url(account, amount, row["payment_code"]),
        }
    return {
        "id": row["id"],
        "status": row["status"],
        "kind": row["kind"],
        "plan_tier": row.get("plan_tier"),
        "billing_cycle": row.get("billing_cycle"),
        "pack_id": row.get("pack_id"),
        "quantity": row.get("quantity") or 1,
        "amount": amount,
        "list_amount": round(float(row.get("list_amount") or amount)),
        "payment_code": row.get("payment_code"),
        "created_at": row.get("created_at"),
        "expires_at": row.get("expires_at"),
        "paid_at": row.get("paid_at"),
        "transfer": transfer,
    }


def _own_order(client, user_id: str, order_id: str) -> dict:
    row = _first(client.table(ORDERS).select("*").eq("id", order_id).eq("user_id", user_id).limit(1).execute())
    if row is None:
        raise HTTPException(status_code=404, detail="order_not_found")
    return row


@router.post("/api/payments/quote")
@limiter.limit(RATE_LIMIT_PAYMENT_QUOTE)
def quote(request: Request, body: ItemIn, user: AuthedUser = Depends(verify_supabase_jwt)):
    return quote_item(_client(), user.user_id, body).public()


@router.post("/api/payments/orders")
@limiter.limit(RATE_LIMIT_PAYMENT_ORDER)
def create_order(request: Request, body: ItemIn, user: AuthedUser = Depends(verify_supabase_jwt)):
    account = bank_account()
    if account is None:
        raise HTTPException(status_code=503, detail="payments_not_configured")
    client = _client()
    priced = quote_item(client, user.user_id, body)

    # One unpaid order at a time: starting a new one abandons the old. If
    # the old one is paid anyway, the webhook still honours it.
    client.table(ORDERS).update({"status": "cancelled"}).eq("user_id", user.user_id).eq("status", "pending").eq(
        "payment_method", "sepay"
    ).execute()

    now = _now()
    base = {
        "user_id": user.user_id,
        "kind": body.kind,
        "plan_tier": body.plan_tier if body.kind == "plan" else None,
        "billing_cycle": body.billing_cycle if body.kind == "plan" else None,
        "pack_id": body.pack_id if body.kind == "pack" else None,
        "quantity": body.quantity,
        "amount": priced.amount,
        "list_amount": priced.list_amount,
        "discount_code_id": priced.discount_code_id,
        "currency": "VND",
        "payment_method": "sepay",
        "status": "pending",
        "expires_at": (now + order_ttl()).isoformat(),
    }
    row = None
    for attempt in range(3):
        try:
            row = _first(client.table(ORDERS).insert({**base, "payment_code": new_payment_code()}).execute())
            break
        except Exception as exc:
            # 32^8 codes make a collision vanishingly rare; retry if it happens.
            if "payment_code" not in str(exc) or attempt == 2:
                logger.exception("Failed to create order for user_id=%s", user.user_id)
                raise HTTPException(status_code=500, detail="order_failed")
    if row is None:
        raise HTTPException(status_code=500, detail="order_failed")

    if priced.amount == 0:
        # Fully discounted: nothing to transfer, complete it now.
        client.rpc("complete_free_checkout", {"p_event_id": row["id"]}).execute()
        row = _own_order(client, user.user_id, row["id"])

    logger.info("Order %s created for user_id=%s: %s VND", row["id"], user.user_id, priced.amount)
    return order_out(row)


@router.get("/api/payments/orders/active")
def active_order(user: AuthedUser = Depends(verify_supabase_jwt)):
    client = _client()
    rows = (
        client.table(ORDERS)
        .select("*")
        .eq("user_id", user.user_id)
        .eq("status", "pending")
        .eq("payment_method", "sepay")
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    ).data or []
    row = rows[0] if rows else None
    expires = _parse_ts(row.get("expires_at")) if row else None
    if row is None or (expires is not None and expires <= _now()):
        return {"order": None}
    return {"order": order_out(row)}


@router.get("/api/payments/orders/{order_id}")
def get_order(order_id: str, user: AuthedUser = Depends(verify_supabase_jwt)):
    return order_out(_own_order(_client(), user.user_id, order_id))


@router.post("/api/payments/orders/{order_id}/cancel")
def cancel_order(order_id: str, user: AuthedUser = Depends(verify_supabase_jwt)):
    client = _client()
    row = _own_order(client, user.user_id, order_id)
    if row["status"] != "pending" or row.get("payment_method") != "sepay":
        raise HTTPException(status_code=409, detail="not_pending")
    updated = _first(
        client.table(ORDERS)
        .update({"status": "cancelled"})
        .eq("id", order_id)
        .eq("user_id", user.user_id)
        .eq("status", "pending")
        .execute()
    )
    # Paid between the read and the update: report the real state.
    return order_out(updated or _own_order(client, user.user_id, order_id))


# --- SePay webhook -------------------------------------------------------------


class SepayWebhookIn(BaseModel):
    """https://docs.sepay.vn/tich-hop-webhooks.html"""

    model_config = ConfigDict(extra="allow")

    id: int | str
    gateway: Optional[str] = None
    transactionDate: Optional[str] = None
    accountNumber: Optional[str] = None
    subAccount: Optional[str] = None
    code: Optional[str] = None
    content: Optional[str] = None
    transferType: str
    transferAmount: float = Field(ge=0)
    accumulated: Optional[float] = None
    referenceCode: Optional[str] = None
    description: Optional[str] = None


def _bank_time(value: Optional[str]) -> Optional[str]:
    """SePay's "2024-07-02 11:08:33" (Vietnam time) as an ISO timestamp."""
    if not value:
        return None
    try:
        parsed = datetime.strptime(value.strip(), "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None
    return parsed.replace(tzinfo=VN_TZ).isoformat()


def _authorized(request: Request, expected: str) -> bool:
    scheme, _, key = request.headers.get("authorization", "").strip().partition(" ")
    return scheme.lower() == "apikey" and hmac.compare_digest(key.strip().encode(), expected.encode())


@router.post("/api/payments/sepay/webhook")
def sepay_webhook(request: Request, body: SepayWebhookIn):
    expected = os.getenv("SEPAY_WEBHOOK_API_KEY", "").strip()
    if not expected:
        # Never accept unauthenticated money notifications.
        logger.error("SePay webhook called but SEPAY_WEBHOOK_API_KEY is not set")
        raise HTTPException(status_code=503, detail="payments_not_configured")
    if not _authorized(request, expected):
        raise HTTPException(status_code=401, detail="unauthorized")

    transfer_type = body.transferType.strip().lower()
    payload = {
        "id": str(body.id),
        "gateway": body.gateway,
        "account_number": body.accountNumber,
        "sub_account": body.subAccount,
        "transfer_type": transfer_type if transfer_type in ("in", "out") else "out",
        "amount": body.transferAmount,
        "content": body.content,
        "reference_code": body.referenceCode,
        "description": body.description,
        "provider_code": body.code,
        "payment_code": extract_payment_code(body.code, body.content),
        "transaction_date": _bank_time(body.transactionDate),
        "raw": body.model_dump(),
    }
    try:
        result = _client().rpc("record_sepay_transaction", {"p_tx": payload}).execute().data
    except HTTPException:
        raise
    except Exception:
        # A non-2xx makes SePay retry (up to 7 times over ~5 hours), which is
        # what we want when the database is briefly unavailable.
        logger.exception("Failed to record SePay transaction %s", body.id)
        raise HTTPException(status_code=500, detail="record_failed")

    logger.info(
        "SePay transaction %s (%s %s VND, code %s): %s%s",
        body.id,
        transfer_type,
        body.transferAmount,
        payload["payment_code"],
        (result or {}).get("status"),
        " (repeat delivery)" if (result or {}).get("duplicate") else "",
    )
    return {"success": True}
