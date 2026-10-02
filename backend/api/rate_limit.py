"""
rate_limit.py
-------------
The single slowapi `Limiter` shared by every route module. slowapi's
middleware reads `app.state.limiter`, so route modules other than app.py
must decorate with this same instance — a second Limiter's limits would
never be enforced.
"""

from __future__ import annotations

from fastapi import Request
from slowapi import Limiter
from slowapi.util import get_remote_address

# Requests reach the API through a Cloudflare Tunnel, whose connector runs on
# the same host, so the socket peer of every public request is loopback.
_LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def client_ip(request: Request) -> str:
    """Real client IP. Cloudflare's `CF-Connecting-IP` is trusted only when
    the request came from the local tunnel connector — a client talking to
    the port directly could otherwise spoof the header to dodge limits."""
    peer = get_remote_address(request)
    if peer in _LOOPBACK:
        forwarded = request.headers.get("cf-connecting-ip", "").strip()
        if forwarded:
            return forwarded
    return peer


def _rate_limit_key(request: Request) -> str:
    """Keyed by verified user_id when available (request.state.user, set by
    auth.verify_supabase_jwt), else by client IP."""
    user = getattr(request.state, "user", None)
    if user is not None:
        return f"user:{user.user_id}"
    return f"ip:{client_ip(request)}"


def ip_key(request: Request) -> str:
    """For unauthenticated endpoints: always the client IP."""
    return f"ip:{client_ip(request)}"


limiter = Limiter(key_func=_rate_limit_key)
