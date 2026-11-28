"""
Ephemeral 0600 local ops token authentication for `backend/api/admin_ops.py`.

Allows the TUI running on the same server host (`127.0.0.1` / `::1`) to
authenticate against `/api/admin/*` without bypassing Cloudflare Tunnel auth:
`cloudflared` also connects to `localhost:8000`, so peer IP alone is NEVER trusted.

All four guards MUST hold:
  1. Scoped strictly to `admin_ops.py` callers.
  2. Constant-time match (`hmac.compare_digest`) against the active ephemeral token.
  3. Peer host strictly in `("127.0.0.1", "::1", "testclient")`.
  4. Zero proxy forwarding headers (`CF-Connecting-IP`, `X-Forwarded-For`,
     `X-Real-IP`, `Forwarded`).
"""
from __future__ import annotations

import hmac
import logging
import os
import secrets
import tempfile
import threading
from pathlib import Path
from typing import Mapping, Optional

from fastapi import HTTPException, Request, WebSocket

from auth import AuthedUser

logger = logging.getLogger("api.local_ops_auth")

LOCAL_TUI_USER_ID = "local-tui"
LOCAL_TOKEN_FILENAME = ".local_ops_token"
LOCAL_TOKEN_HEADER = "X-Local-Ops-Token"
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "testclient"})
PROXY_HEADERS = frozenset({"cf-connecting-ip", "x-forwarded-for", "x-real-ip", "forwarded"})

_TOKEN_LOCK = threading.Lock()
_ACTIVE_TOKEN: Optional[str] = None
_ACTIVE_TOKEN_PATH: Optional[Path] = None


def init_local_ops_token(log_dir: Path) -> str:
    """Create/replace `log_dir/.local_ops_token` atomically with `0600` mode."""
    global _ACTIVE_TOKEN, _ACTIVE_TOKEN_PATH
    token = secrets.token_urlsafe(36)  # 36 random bytes -> 48 URL-safe chars
    token_dir = Path(log_dir)
    token_dir.mkdir(parents=True, exist_ok=True)
    target = token_dir / LOCAL_TOKEN_FILENAME

    fd, tmp_name = tempfile.mkstemp(prefix=".local_ops_token.", dir=str(token_dir))
    tmp_path = Path(tmp_name)
    try:
        os.chmod(tmp_path, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(token + "\n")
        os.chmod(tmp_path, 0o600)
        os.replace(tmp_path, target)
        os.chmod(target, 0o600)
    except Exception:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise

    with _TOKEN_LOCK:
        _ACTIVE_TOKEN = token
        _ACTIVE_TOKEN_PATH = target
    return token


def cleanup_local_ops_token(log_dir: Optional[Path] = None) -> None:
    """Remove the ephemeral token file and clear the in-memory secret."""
    global _ACTIVE_TOKEN, _ACTIVE_TOKEN_PATH
    with _TOKEN_LOCK:
        target = (Path(log_dir) / LOCAL_TOKEN_FILENAME) if log_dir is not None else _ACTIVE_TOKEN_PATH
        _ACTIVE_TOKEN = None
        _ACTIVE_TOKEN_PATH = None
    if target is not None:
        try:
            target.unlink(missing_ok=True)
        except OSError:
            logger.debug("Could not unlink %s during cleanup", target, exc_info=True)


def set_active_local_ops_token_for_test(token: Optional[str]) -> Optional[str]:
    """Test helper to inspect/swap active token without leaking across suites."""
    global _ACTIVE_TOKEN
    with _TOKEN_LOCK:
        prev = _ACTIVE_TOKEN
        _ACTIVE_TOKEN = token
        return prev


def read_local_ops_token(log_dir: Path) -> Optional[str]:
    """Read the local ops token from disk (used by LocalDashboardProvider)."""
    path = Path(log_dir) / LOCAL_TOKEN_FILENAME
    try:
        token = path.read_text(encoding="utf-8").strip()
        return token or None
    except OSError:
        return None


def _has_proxy_header(headers: Mapping[str, str]) -> bool:
    for key in headers.keys():
        if str(key).lower() in PROXY_HEADERS:
            return True
    return False


def verify_local_ops_token(
    presented: Optional[str],
    *,
    client_host: Optional[str],
    headers: Mapping[str, str],
) -> Optional[AuthedUser]:
    """Verify local ops token if `presented` is provided.

    Returns `None` when `presented is None` so normal JWT auth continues.
    Raises HTTPException(401/403) whenever `presented` is provided and invalid.
    """
    if presented is None:
        return None
    if not isinstance(presented, str) or not presented:
        raise HTTPException(status_code=401, detail="Invalid local ops token.")
    if _has_proxy_header(headers):
        logger.warning("Rejected local ops token presented behind proxy header from %r", client_host)
        raise HTTPException(status_code=403, detail="Local ops token cannot be used via a proxy.")
    if client_host not in LOOPBACK_HOSTS:
        logger.warning("Rejected local ops token from non-loopback host %r", client_host)
        raise HTTPException(status_code=403, detail="Local ops token is restricted to loopback.")

    with _TOKEN_LOCK:
        expected = _ACTIVE_TOKEN
    if not expected or not hmac.compare_digest(presented.strip(), expected):
        raise HTTPException(status_code=401, detail="Invalid local ops token.")

    return AuthedUser(user_id=LOCAL_TUI_USER_ID, email=None, role="admin", is_admin=True)


def authenticate_local_ops_request(request: Request) -> Optional[AuthedUser]:
    """HTTP helper for `admin_ops.require_admin`."""
    headers = getattr(request, "headers", None)
    if headers is None:
        return None
    presented = headers.get(LOCAL_TOKEN_HEADER)
    if presented is None:
        return None
    client = getattr(request, "client", None)
    client_host = getattr(client, "host", None)
    return verify_local_ops_token(presented, client_host=client_host, headers=headers)


def authenticate_local_ops_ws(websocket: WebSocket, presented: Optional[str]) -> Optional[AuthedUser]:
    """WebSocket helper for `admin_ops._ws_handshake_auth`."""
    if presented is None:
        return None
    headers = getattr(websocket, "headers", None) or {}
    client = getattr(websocket, "client", None)
    client_host = getattr(client, "host", None)
    return verify_local_ops_token(presented, client_host=client_host, headers=headers)
