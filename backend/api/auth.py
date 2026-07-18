"""
auth.py
-------
FastAPI dependency that verifies Supabase-issued JWTs LOCALLY (via PyJWT +
the project's JWT secret), avoiding a network round trip to Supabase Auth on
every request. Mirrors the two-step pattern in
`apps/admin/src/lib/auth.tsx` (`useAdminAuth`): (1) verify the session/token
to get a user id, (2) look up `profiles.role` for that user id to decide
admin-ness. Step 1 here is local/offline; step 2 is a lightweight DB read
through the service-role client (backend/api/supabase_client.py).
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Optional

import jwt
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from supabase_client import get_client

logger = logging.getLogger(__name__)

SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET")
# Supabase-issued access tokens carry aud="authenticated" by default.
JWT_AUDIENCE = os.getenv("SUPABASE_JWT_AUDIENCE", "authenticated")
JWT_ALGORITHMS = ["HS256"]

_bearer_scheme = HTTPBearer(auto_error=False)


@dataclass
class AuthedUser:
    user_id: str
    email: Optional[str]
    role: str  # app-level role from `profiles.role`: "user" | "admin"
    is_admin: bool


def _fetch_profile_role(user_id: str) -> str:
    """
    Look up the caller's app-level role from `profiles`. Uses the
    service-role client so it bypasses RLS (this IS the authorization
    check, not something RLS needs to gate). Defaults to "user" (never
    silently grants admin) if Supabase isn't configured or the lookup
    fails for any reason.
    """
    client = get_client()
    if client is None:
        return "user"
    try:
        resp = (
            client.table("profiles")
            .select("role")
            .eq("id", user_id)
            .single()
            .execute()
        )
        data = resp.data or {}
        return data.get("role") or "user"
    except Exception:
        logger.exception("Failed to fetch profile role for user_id=%s", user_id)
        return "user"


async def verify_supabase_jwt(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer_scheme),
) -> AuthedUser:
    """
    FastAPI dependency. Verifies the `Authorization: Bearer <token>` header
    as a Supabase-issued JWT, entirely locally (PyJWT signature/exp/aud
    checks against SUPABASE_JWT_SECRET — no call out to Supabase Auth).

    Raises 401 on any missing/invalid/expired token. On success, attaches
    the resulting AuthedUser to `request.state.user` and returns it, so
    route handlers can either take it as a dependency return value or read
    `request.state.user`.
    """
    if not SUPABASE_JWT_SECRET:
        # Fail loudly rather than silently accepting unverified requests.
        logger.error(
            "SUPABASE_JWT_SECRET is not configured; refusing to authenticate requests."
        )
        raise HTTPException(status_code=500, detail="Server auth is not configured.")

    if credentials is None or not credentials.credentials:
        raise HTTPException(status_code=401, detail="Missing bearer token.")

    token = credentials.credentials

    try:
        payload = jwt.decode(
            token,
            SUPABASE_JWT_SECRET,
            algorithms=JWT_ALGORITHMS,
            audience=JWT_AUDIENCE,
            options={"require": ["exp", "sub"]},
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token has expired.")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token.")

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token payload.")

    role = _fetch_profile_role(user_id)

    user = AuthedUser(
        user_id=user_id,
        email=payload.get("email"),
        role=role,
        is_admin=role == "admin",
    )

    request.state.user = user
    return user


def require_owner_or_admin(resource_user_id: Optional[str], user: AuthedUser) -> None:
    """
    Ownership guard for per-resource routes (GET/DELETE /api/reports/{id},
    GET /api/jobs/{id}): admins may access anything; everyone else must
    own the resource. Raises 404 (not 403) on mismatch so a caller can't
    distinguish "not yours" from "doesn't exist" and enumerate other
    users' resource ids.
    """
    if user.is_admin:
        return
    if resource_user_id is None or resource_user_id != user.user_id:
        raise HTTPException(status_code=404, detail="Not found.")
