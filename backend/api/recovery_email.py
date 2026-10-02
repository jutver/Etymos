"""
recovery_email.py
-----------------
A user's optional second address for password recovery.

Supabase Auth only ever emails a user's primary address, so this module
owns the whole recovery-email path:

  GET    /api/account/recovery-email          status for the signed-in user
  PUT    /api/account/recovery-email          set/replace it, emails a verify link
  DELETE /api/account/recovery-email          remove it
  POST   /api/account/recovery-email/verify   redeem a verify link (no session needed)
  POST   /api/auth/forgot-password            send a reset link to a VERIFIED recovery address

An address is only usable for resets once its owner clicked the verify link,
so a typo can never route someone's reset links to a stranger. Verify tokens
are random, single-use, stored hashed, and expire after LINK_TTL_MINUTES —
the same 30-minute window Supabase is configured with for its own links.

The reset link itself is minted by Supabase (admin generate_link, type
"recovery", for the account's primary email) so it lands on the same
/reset-password page and expires under the same Supabase setting as a reset
requested for the primary address.

Rows live in public.recovery_emails, which has RLS on and no policies: only
this service-role backend can read or write them.
"""

# No `from __future__ import annotations`: slowapi wraps the limited routes,
# and FastAPI resolves string annotations against the wrapper's module, so
# the request-body models would silently turn into query parameters (422).
import hashlib
import logging
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel, Field

import mailer
from auth import AuthedUser, verify_supabase_jwt
from email_templates import LINK_TTL_MINUTES, recovery_reset_email, recovery_verify_email
from rate_limit import ip_key, limiter
from supabase_client import get_client

logger = logging.getLogger(__name__)

router = APIRouter()

TABLE = "recovery_emails"
PUBLIC_APP_URL = os.getenv("PUBLIC_APP_URL", "https://www.etymos.site").rstrip("/")
LINK_TTL = timedelta(minutes=LINK_TTL_MINUTES)
# Minimum gap between two emails to the same recovery address, whichever
# endpoint triggers them — stops the endpoints being used to flood an inbox.
RESEND_INTERVAL = timedelta(seconds=60)
RATE_LIMIT_FORGOT_PASSWORD = os.getenv("RATE_LIMIT_FORGOT_PASSWORD", "10/hour")
RATE_LIMIT_RECOVERY_VERIFY = os.getenv("RATE_LIMIT_RECOVERY_VERIFY", "30/hour")

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class RecoveryEmailIn(BaseModel):
    email: str = Field(max_length=254)
    locale: Literal["vi", "en"] = "vi"


class VerifyIn(BaseModel):
    token: str = Field(min_length=20, max_length=200)


class ForgotIn(BaseModel):
    email: str = Field(max_length=254)
    locale: Literal["vi", "en"] = "vi"


def normalize_email(raw: str) -> Optional[str]:
    email = raw.strip().lower()
    if len(email) > 254 or not _EMAIL_RE.match(email):
        return None
    return email


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


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


def _status(row: Optional[dict]) -> dict:
    if not row:
        return {"email": None, "verified": False, "pending": False}
    verified = row.get("verified_at") is not None
    return {"email": row["email"], "verified": verified, "pending": not verified}


def _recently_sent(row: Optional[dict]) -> bool:
    sent = _parse_ts(row.get("last_sent_at")) if row else None
    return sent is not None and _now() - sent < RESEND_INTERVAL


@router.get("/api/account/recovery-email")
def get_recovery_email(user: AuthedUser = Depends(verify_supabase_jwt)):
    return _status(_row_for_user(_client(), user.user_id))


@router.put("/api/account/recovery-email")
def set_recovery_email(body: RecoveryEmailIn, user: AuthedUser = Depends(verify_supabase_jwt)):
    """Set (or re-send the verify link for) the caller's recovery address.
    Replacing a verified address un-verifies it until the new one is
    confirmed — the old address stops working for resets immediately."""
    email = normalize_email(body.email)
    if email is None:
        raise HTTPException(status_code=400, detail="Enter a valid email address.")
    if user.email and email == user.email.lower():
        raise HTTPException(status_code=400, detail="Use a different address from your login email.")
    if not mailer.is_configured():
        raise HTTPException(status_code=503, detail="Email sending is not configured on this server.")

    client = _client()
    row = _row_for_user(client, user.user_id)
    if row and row["email"] == email and row.get("verified_at"):
        return _status(row)
    if row and row["email"] == email and _recently_sent(row):
        raise HTTPException(status_code=429, detail="We just sent a link to this address. Wait a minute before asking again.")

    token = secrets.token_urlsafe(32)
    now = _now()
    client.table(TABLE).upsert(
        {
            "user_id": user.user_id,
            "email": email,
            "verified_at": None,
            "verify_token_hash": hash_token(token),
            "verify_expires_at": (now + LINK_TTL).isoformat(),
            "last_sent_at": now.isoformat(),
            "updated_at": now.isoformat(),
        },
        on_conflict="user_id",
    ).execute()

    # In the URL fragment, not the query: fragments never reach server logs
    # or Referer headers.
    url = f"{PUBLIC_APP_URL}/recovery-email/verify#token={token}"
    try:
        mailer.send_email(email, recovery_verify_email(body.locale, account_email=user.email or "", url=url), body.locale)
    except Exception:
        logger.exception("Failed to send recovery verification email for user_id=%s", user.user_id)
        raise HTTPException(status_code=502, detail="We couldn't send the verification email. Try again in a few minutes.")
    return {"email": email, "verified": False, "pending": True}


@router.delete("/api/account/recovery-email")
def delete_recovery_email(user: AuthedUser = Depends(verify_supabase_jwt)):
    _client().table(TABLE).delete().eq("user_id", user.user_id).execute()
    return _status(None)


@router.post("/api/account/recovery-email/verify")
@limiter.limit(RATE_LIMIT_RECOVERY_VERIFY, key_func=ip_key)
def verify_recovery_email(request: Request, body: VerifyIn):
    """Redeem a verify link. Needs no session: the token itself proves the
    click came from the inbox, and it may be opened on another device."""
    client = _client()
    res = client.table(TABLE).select("*").eq("verify_token_hash", hash_token(body.token)).limit(1).execute()
    row = res.data[0] if res.data else None
    if row is None:
        raise HTTPException(status_code=404, detail="invalid")
    expires = _parse_ts(row.get("verify_expires_at"))
    if expires is None or expires <= _now():
        raise HTTPException(status_code=410, detail="expired")

    taken = (
        client.table(TABLE)
        .select("user_id")
        .eq("email", row["email"])
        .not_.is_("verified_at", "null")
        .neq("user_id", row["user_id"])
        .limit(1)
        .execute()
    )
    if taken.data:
        raise HTTPException(status_code=409, detail="in_use")

    client.table(TABLE).update(
        {
            "verified_at": _now().isoformat(),
            "verify_token_hash": None,
            "verify_expires_at": None,
            "updated_at": _now().isoformat(),
        }
    ).eq("user_id", row["user_id"]).execute()
    return {"email": row["email"], "verified": True, "pending": False}


def _send_reset_via_recovery(email: str, locale: Literal["vi", "en"]) -> None:
    """Runs after the response is sent, so neither the response nor its
    timing reveals whether `email` belongs to anyone."""
    try:
        client = get_client()
        if client is None or not mailer.is_configured():
            return
        res = client.table(TABLE).select("*").eq("email", email).not_.is_("verified_at", "null").limit(1).execute()
        row = res.data[0] if res.data else None
        if row is None or _recently_sent(row):
            return
        account = client.auth.admin.get_user_by_id(row["user_id"]).user
        if account is None or not account.email:
            return
        link = client.auth.admin.generate_link(
            {
                "type": "recovery",
                "email": account.email,
                "options": {"redirect_to": f"{PUBLIC_APP_URL}/reset-password"},
            }
        )
        mailer.send_email(
            email,
            recovery_reset_email(locale, account_email=account.email, url=link.properties.action_link),
            locale,
        )
        client.table(TABLE).update({"last_sent_at": _now().isoformat()}).eq("user_id", row["user_id"]).execute()
    except Exception:
        logger.exception("Failed to send a password reset to a recovery address")


@router.post("/api/auth/forgot-password", status_code=202)
@limiter.limit(RATE_LIMIT_FORGOT_PASSWORD, key_func=ip_key)
def forgot_password(request: Request, body: ForgotIn, background: BackgroundTasks):
    """The recovery-address half of "Forgot password". The web app calls
    Supabase's resetPasswordForEmail for the same address in parallel, which
    covers the case where it is a primary login email. Always 202, whether
    or not anything was sent."""
    email = normalize_email(body.email)
    if email is not None:
        background.add_task(_send_reset_via_recovery, email, body.locale)
    return {"ok": True}
