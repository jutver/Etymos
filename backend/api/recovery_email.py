"""
recovery_email.py
-----------------
A user's optional second address, used to get back into the account when
the login email itself is unreachable. Supabase Auth only ever emails the
login address, so this module owns the whole recovery-email path, and both
of its flows authenticate with a 6-digit one-time code sent to that address:

Confirming the address (signed in, profile page):
  GET    /api/account/recovery-email           status
  PUT    /api/account/recovery-email           set/replace it, emails a confirm code
  POST   /api/account/recovery-email/confirm   check the code -> address confirmed
  DELETE /api/account/recovery-email           remove it

Recovering the account (signed out, /recover-account):
  POST   /api/auth/recovery/request            email a reset code to a CONFIRMED address
  POST   /api/auth/recovery/verify             check the code -> the accounts it covers,
                                               or, with user_id, -> Supabase recovery token

One address may be the confirmed recovery email of several accounts. A
request sends ONE code covering all of them; verifying it without a user_id
lists those accounts (login email + name) so the user can pick one, and
verifying again with the chosen user_id spends the code. The list is only
revealed after a correct code — that is, to whoever controls the inbox —
never to someone who merely typed the address.

Codes expire after CODE_TTL_MINUTES, allow MAX_ATTEMPTS wrong guesses before
being discarded, are stored hashed, and are scoped to one purpose — a confirm
code can't reset a password and vice versa.

The chosen account's code is exchanged for a Supabase recovery token_hash (admin
generate_link, type "recovery", for the account's login email). The browser
redeems it with supabase.auth.verifyOtp, which signs it into a short-lived
recovery session that may set a new password — the same session a normal
"forgot password" link creates.

The signed-out endpoints never reveal whether an address belongs to an
account: request always answers 202, and verify gives one generic error for
an unknown address, a wrong code, an expired code or too many attempts.

Rows live in public.recovery_emails, which has RLS on and no policies: only
this service-role backend can read or write them.
"""

# No `from __future__ import annotations`: slowapi wraps the limited routes,
# and FastAPI resolves string annotations against the wrapper's module, so
# the request-body models would silently turn into query parameters (422).
import hashlib
import hmac
import logging
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel, Field

import mailer
import notifications
from auth import AuthedUser, verify_supabase_jwt
from email_templates import LINK_TTL_MINUTES, recovery_confirm_code_email, recovery_reset_code_email
from rate_limit import ip_key, limiter
from supabase_client import get_client

logger = logging.getLogger(__name__)

router = APIRouter()

TABLE = "recovery_emails"
CODE_TTL_MINUTES = LINK_TTL_MINUTES
CODE_TTL = timedelta(minutes=CODE_TTL_MINUTES)
MAX_ATTEMPTS = 5
# Minimum gap between two emails to the same recovery address, whichever
# flow triggers them — stops the endpoints being used to flood an inbox.
RESEND_INTERVAL = timedelta(seconds=60)
RATE_LIMIT_RECOVERY_REQUEST = os.getenv("RATE_LIMIT_RECOVERY_REQUEST", "10/hour")
RATE_LIMIT_RECOVERY_VERIFY = os.getenv("RATE_LIMIT_RECOVERY_VERIFY", "30/hour")

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

Purpose = Literal["confirm", "reset"]


class RecoveryEmailIn(BaseModel):
    email: str = Field(max_length=254)


class CodeIn(BaseModel):
    code: str = Field(min_length=6, max_length=6, pattern=r"^\d{6}$")


class RecoveryRequestIn(BaseModel):
    email: str = Field(max_length=254)


class RecoveryVerifyIn(BaseModel):
    email: str = Field(max_length=254)
    code: str = Field(min_length=6, max_length=6, pattern=r"^\d{6}$")
    # Omitted: list the accounts the code covers. Set: recover that account.
    user_id: Optional[str] = Field(default=None, max_length=64)


def normalize_email(raw: str) -> Optional[str]:
    email = raw.strip().lower()
    if len(email) > 254 or not _EMAIL_RE.match(email):
        return None
    return email


def new_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def hash_code(purpose: Purpose, user_id: str, code: str) -> str:
    """Bound to purpose and account, so a hash can't be replayed across either."""
    return hashlib.sha256(f"{purpose}:{user_id}:{code}".encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_ts(value: Optional[str]) -> Optional[datetime]:
    """Postgres timestamptz as returned by PostgREST. Python 3.10's
    fromisoformat rejects a trailing 'Z' and fractions that aren't 3 or 6
    digits, both of which PostgREST can emit, so normalise first."""
    if not value:
        return None
    value = value.replace("Z", "+00:00")
    value = re.sub(r"\.(\d+)", lambda m: "." + (m.group(1) + "000000")[:6], value)
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _client():
    client = get_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Recovery email is not configured on this server.")
    return client


def _row_for_user(client, user_id: str) -> Optional[dict]:
    res = client.table(TABLE).select("*").eq("user_id", user_id).limit(1).execute()
    return res.data[0] if res.data else None


def _verified_rows_for_email(client, email: str) -> list[dict]:
    res = client.table(TABLE).select("*").eq("email", email).not_.is_("verified_at", "null").execute()
    return res.data or []


def _status(row: Optional[dict]) -> dict:
    if not row:
        return {"email": None, "verified": False, "pending": False}
    verified = row.get("verified_at") is not None
    return {"email": row["email"], "verified": verified, "pending": not verified}


def _recently_sent(row: Optional[dict]) -> bool:
    sent = _parse_ts(row.get("last_sent_at")) if row else None
    return sent is not None and _now() - sent < RESEND_INTERVAL


_COLUMNS = {
    "confirm": ("verify_code_hash", "verify_expires_at", "verify_attempts"),
    "reset": ("reset_code_hash", "reset_expires_at", "reset_attempts"),
}


def _cleared(purpose: Purpose) -> dict:
    hash_col, exp_col, att_col = _COLUMNS[purpose]
    return {hash_col: None, exp_col: None, att_col: 0}


def _check_code(client, row: dict, purpose: Purpose, code: str) -> str:
    """Returns "ok", "none", "expired", "too_many" or "wrong", and keeps the
    row's attempt counter / code in step with the outcome."""
    hash_col, exp_col, att_col = _COLUMNS[purpose]
    stored = row.get(hash_col)
    if not stored:
        return "none"
    expires = _parse_ts(row.get(exp_col))
    if expires is None or expires <= _now():
        client.table(TABLE).update(_cleared(purpose)).eq("user_id", row["user_id"]).execute()
        return "expired"
    if hmac.compare_digest(stored, hash_code(purpose, row["user_id"], code)):
        return "ok"
    attempts = int(row.get(att_col) or 0) + 1
    if attempts >= MAX_ATTEMPTS:
        client.table(TABLE).update(_cleared(purpose)).eq("user_id", row["user_id"]).execute()
        return "too_many"
    client.table(TABLE).update({att_col: attempts}).eq("user_id", row["user_id"]).execute()
    return "wrong"


# --- Confirming the address (signed in) ----------------------------------


@router.get("/api/account/recovery-email")
def get_recovery_email(user: AuthedUser = Depends(verify_supabase_jwt)):
    return _status(_row_for_user(_client(), user.user_id))


@router.put("/api/account/recovery-email")
def set_recovery_email(
    body: RecoveryEmailIn, background: BackgroundTasks, user: AuthedUser = Depends(verify_supabase_jwt)
):
    """Set (or re-send the code for) the caller's recovery address.
    Replacing a confirmed address un-confirms it until the new one is
    confirmed — the old address stops working for recovery immediately."""
    email = normalize_email(body.email)
    if email is None:
        raise HTTPException(status_code=400, detail="invalid_email")
    if user.email and email == user.email.lower():
        raise HTTPException(status_code=400, detail="same_as_login")
    if not mailer.is_configured():
        raise HTTPException(status_code=503, detail="Email sending is not configured on this server.")

    client = _client()
    row = _row_for_user(client, user.user_id)
    if row and row["email"] == email and row.get("verified_at"):
        return _status(row)
    if row and row["email"] == email and _recently_sent(row):
        raise HTTPException(status_code=429, detail="recently_sent")

    code = new_code()
    now = _now()
    client.table(TABLE).upsert(
        {
            "user_id": user.user_id,
            "email": email,
            "verified_at": None,
            "verify_code_hash": hash_code("confirm", user.user_id, code),
            "verify_expires_at": (now + CODE_TTL).isoformat(),
            "verify_attempts": 0,
            **_cleared("reset"),
            "last_sent_at": now.isoformat(),
            "updated_at": now.isoformat(),
        },
        on_conflict="user_id",
    ).execute()

    try:
        mailer.send_email(email, recovery_confirm_code_email(account_email=user.email or "", code=code))
    except Exception:
        logger.exception("Failed to send recovery confirm code for user_id=%s", user.user_id)
        raise HTTPException(status_code=502, detail="send_failed")
    if row and row.get("verified_at") and row["email"] != email:
        # A confirmed address was just replaced: tell the login email.
        background.add_task(
            notifications.notify_recovery_email_removed, user.user_id, user.email, row["email"], email
        )
    return {"email": email, "verified": False, "pending": True}


@router.post("/api/account/recovery-email/confirm")
def confirm_recovery_email(
    body: CodeIn, background: BackgroundTasks, user: AuthedUser = Depends(verify_supabase_jwt)
):
    client = _client()
    row = _row_for_user(client, user.user_id)
    if row is None or row.get("verified_at"):
        raise HTTPException(status_code=400, detail="no_code")

    result = _check_code(client, row, "confirm", body.code)
    if result == "none":
        raise HTTPException(status_code=400, detail="no_code")
    if result == "expired":
        raise HTTPException(status_code=410, detail="expired")
    if result == "too_many":
        raise HTTPException(status_code=429, detail="too_many_attempts")
    if result == "wrong":
        raise HTTPException(status_code=400, detail="wrong_code")

    client.table(TABLE).update(
        {"verified_at": _now().isoformat(), **_cleared("confirm"), "updated_at": _now().isoformat()}
    ).eq("user_id", user.user_id).execute()
    background.add_task(notifications.notify_recovery_email_added, user.user_id, user.email, row["email"])
    return {"email": row["email"], "verified": True, "pending": False}


@router.delete("/api/account/recovery-email")
def delete_recovery_email(background: BackgroundTasks, user: AuthedUser = Depends(verify_supabase_jwt)):
    client = _client()
    row = _row_for_user(client, user.user_id)
    client.table(TABLE).delete().eq("user_id", user.user_id).execute()
    if row and row.get("verified_at"):
        background.add_task(notifications.notify_recovery_email_removed, user.user_id, user.email, row["email"], None)
    return _status(None)


# --- Recovering the account (signed out) ---------------------------------


def _accounts(client, rows: list[dict]) -> list[dict]:
    """Login email + display name for each row's account, skipping accounts
    that no longer exist."""
    accounts = []
    for row in rows:
        try:
            user = client.auth.admin.get_user_by_id(row["user_id"]).user
        except Exception:
            logger.exception("Couldn't load account user_id=%s", row["user_id"])
            continue
        if user is None or not user.email:
            continue
        name = (user.user_metadata or {}).get("display_name") or ""
        accounts.append({"user_id": row["user_id"], "email": user.email, "name": name})
    return sorted(accounts, key=lambda a: a["email"])


def _send_reset_code(email: str) -> None:
    """Runs after the response is sent, so neither the response nor its
    timing reveals whether `email` belongs to anyone. One code is stored
    (hashed per account) on every account using this recovery address."""
    try:
        client = get_client()
        if client is None or not mailer.is_configured():
            return
        rows = _verified_rows_for_email(client, email)
        if not rows or any(_recently_sent(r) for r in rows):
            return
        accounts = _accounts(client, rows)
        if not accounts:
            return
        code = new_code()
        now = _now()
        for row in rows:
            client.table(TABLE).update(
                {
                    "reset_code_hash": hash_code("reset", row["user_id"], code),
                    "reset_expires_at": (now + CODE_TTL).isoformat(),
                    "reset_attempts": 0,
                    "last_sent_at": now.isoformat(),
                }
            ).eq("user_id", row["user_id"]).execute()
        mailer.send_email(email, recovery_reset_code_email(account_emails=[a["email"] for a in accounts], code=code))
    except Exception:
        logger.exception("Failed to send an account recovery code")


@router.post("/api/auth/recovery/request", status_code=202)
@limiter.limit(RATE_LIMIT_RECOVERY_REQUEST, key_func=ip_key)
def request_recovery_code(request: Request, body: RecoveryRequestIn, background: BackgroundTasks):
    """Always 202, whether or not anything was sent."""
    email = normalize_email(body.email)
    if email is not None:
        background.add_task(_send_reset_code, email)
    return {"ok": True}


@router.post("/api/auth/recovery/verify")
@limiter.limit(RATE_LIMIT_RECOVERY_VERIFY, key_func=ip_key)
def verify_recovery_code(request: Request, body: RecoveryVerifyIn):
    """Without user_id: a correct code returns {"accounts": [...]} and stays
    valid so the user can pick one. With user_id: the code is spent and that
    account's recovery token returned as {"token_hash": ...}."""
    invalid = HTTPException(status_code=400, detail="invalid_code")
    email = normalize_email(body.email)
    if email is None:
        raise invalid
    client = _client()
    rows = _verified_rows_for_email(client, email)
    if not rows:
        raise invalid
    # Same code on every row; checking each keeps their attempt counters in
    # step, so a wrong guess counts once against the whole address.
    results = [_check_code(client, row, "reset", body.code) for row in rows]
    # Only accounts this code was issued for — not one that confirmed the
    # address after the code went out.
    covered = [row for row, result in zip(rows, results) if result == "ok"]
    if not covered:
        raise invalid

    if body.user_id is None:
        accounts = _accounts(client, covered)
        if not accounts:
            raise invalid
        return {"accounts": accounts}

    chosen = next((r for r in covered if r["user_id"] == body.user_id), None)
    if chosen is None:
        raise invalid
    # Single use: the code is spent for every account before the token is minted.
    for row in rows:
        client.table(TABLE).update(_cleared("reset")).eq("user_id", row["user_id"]).execute()
    try:
        account = client.auth.admin.get_user_by_id(chosen["user_id"]).user
        link = client.auth.admin.generate_link({"type": "recovery", "email": account.email})
    except Exception:
        logger.exception("Failed to mint a recovery token for user_id=%s", chosen["user_id"])
        raise HTTPException(status_code=502, detail="recovery_failed")
    return {"token_hash": link.properties.hashed_token}
