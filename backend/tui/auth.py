"""Remote admin authentication (Supabase GoTrue password + TOTP MFA `aal2` & `--token`)."""
from __future__ import annotations

import base64
import getpass
import json
import os
import sys
import time
from pathlib import Path
from typing import Callable, Optional

import httpx
from platformdirs import user_config_dir

from .models import RemoteSessionCache


def default_session_path() -> Path:
    return Path(user_config_dir("etymos")) / "tui_session.json"


def decode_jwt_claims_unverified(token: str) -> dict:
    """Decode JWT payload claims for local UX/expiry scheduling only (server verifies signature)."""
    parts = (token or "").split(".")
    if len(parts) != 3:
        return {}
    payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        raw = base64.urlsafe_b64decode(payload_b64.encode("ascii"))
        data = json.loads(raw.decode("utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


_PUBLIC_SUPABASE_URL_KEYS = ("SUPABASE_URL", "VITE_SUPABASE_URL")
_PUBLIC_SUPABASE_KEY_KEYS = (
    "SUPABASE_ANON_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
    "VITE_SUPABASE_ANON_KEY",
    "VITE_SUPABASE_PUBLISHABLE_KEY",
)


def discover_supabase_config(
    *,
    supabase_url: Optional[str] = None,
    supabase_anon_key: Optional[str] = None,
    repo_root: Optional[Path] = None,
) -> tuple[Optional[str], Optional[str]]:
    """Resolve public Supabase URL and anon/publishable key from flags, env, or `.env*` files.

    Strictly ignores all non-public keys (never reads service-role keys or secrets).
    """
    url = supabase_url or os.getenv("SUPABASE_URL") or os.getenv("VITE_SUPABASE_URL")
    anon = (
        supabase_anon_key
        or os.getenv("SUPABASE_ANON_KEY")
        or os.getenv("SUPABASE_PUBLISHABLE_KEY")
        or os.getenv("VITE_SUPABASE_ANON_KEY")
        or os.getenv("VITE_SUPABASE_PUBLISHABLE_KEY")
    )
    if url and anon:
        return url.rstrip("/"), anon

    root = repo_root or Path(__file__).resolve().parent.parent.parent
    candidates = (
        ".env.local",
        ".env",
        "apps/admin/.env.local",
        "apps/admin/.env",
        "apps/web/.env.local",
        "apps/web/.env",
        "backend/.env.local",
        "backend/.env",
    )
    for rel in candidates:
        candidate = root / rel
        if not candidate.is_file():
            continue
        try:
            for line in candidate.read_text(encoding="utf-8").splitlines():
                stripped = line.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                if stripped.startswith("export "):
                    stripped = stripped[7:].strip()
                if "=" not in stripped:
                    continue
                k, v = stripped.split("=", 1)
                k = k.strip()
                if k in _PUBLIC_SUPABASE_URL_KEYS and not url:
                    cleaned = v.strip().strip("'\"")
                    if cleaned:
                        url = cleaned
                elif k in _PUBLIC_SUPABASE_KEY_KEYS and not anon:
                    cleaned = v.strip().strip("'\"")
                    if cleaned:
                        anon = cleaned
            if url and anon:
                break
        except OSError:
            continue
    return (url.rstrip("/") if url else None), anon


class AuthError(RuntimeError):
    """Raised when remote authentication or MFA verification fails."""


class RemoteAuthManager:
    """Handles Supabase GoTrue password + TOTP MFA (`aal2`) login, refresh, and `0600` cache."""

    def __init__(
        self,
        *,
        session_path: Optional[Path] = None,
        http_client_factory: Optional[Callable[[], httpx.Client]] = None,
    ) -> None:
        self.session_path = Path(session_path) if session_path else default_session_path()
        self._client_factory = http_client_factory or (lambda: httpx.Client(timeout=15.0))

    def load_cached_session(self, api_url: Optional[str] = None) -> Optional[RemoteSessionCache]:
        if not self.session_path.is_file():
            return None
        try:
            data = json.loads(self.session_path.read_text(encoding="utf-8"))
            session = RemoteSessionCache(
                api_url=str(data["api_url"]).rstrip("/"),
                supabase_url=str(data["supabase_url"]).rstrip("/"),
                access_token=str(data["access_token"]),
                refresh_token=str(data["refresh_token"]),
                expires_at=float(data["expires_at"]),
                email=str(data.get("email") or ""),
                user_id=str(data.get("user_id") or ""),
            )
            if api_url and session.api_url != api_url.rstrip("/"):
                return None
            return session
        except Exception:
            return None

    def save_cached_session(self, session: RemoteSessionCache) -> None:
        self.session_path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps({
            "api_url": session.api_url.rstrip("/"),
            "supabase_url": session.supabase_url.rstrip("/"),
            "access_token": session.access_token,
            "refresh_token": session.refresh_token,
            "expires_at": session.expires_at,
            "email": session.email,
            "user_id": session.user_id,
        })
        fd = os.open(str(self.session_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(payload)
            os.chmod(self.session_path, 0o600)
        except Exception:
            raise

    def clear_cached_session(self) -> bool:
        try:
            existed = self.session_path.exists()
            self.session_path.unlink(missing_ok=True)
            return existed
        except OSError:
            return False

    def validate_aal2(self, token: str) -> tuple[dict, float]:
        claims = decode_jwt_claims_unverified(token)
        if not claims:
            raise AuthError("Invalid JWT format.")
        exp = float(claims.get("exp") or 0)
        if exp <= time.time():
            raise AuthError("Access token has expired.")
        if claims.get("aal") != "aal2":
            raise AuthError(
                "Admin endpoints require authenticator MFA (aal2). Sign in with `--login` and complete TOTP verification."
            )
        return claims, exp

    def interactive_login(
        self,
        *,
        api_url: str,
        supabase_url: Optional[str] = None,
        supabase_anon_key: Optional[str] = None,
        email: Optional[str] = None,
        password: Optional[str] = None,
        totp_code: Optional[str] = None,
        input_fn: Callable[[str], str] = input,
        getpass_fn: Callable[[str], str] = getpass.getpass,
    ) -> RemoteSessionCache:
        sb_url, sb_anon = discover_supabase_config(
            supabase_url=supabase_url,
            supabase_anon_key=supabase_anon_key,
        )
        if not sb_url or not sb_anon:
            raise AuthError(
                "Supabase URL and anon key are required for --login "
                "(pass --supabase-url / --supabase-anon-key or set SUPABASE_URL / SUPABASE_ANON_KEY)."
            )

        if email is None:
            email = input_fn("Admin email: ").strip()
        if password is None:
            password = getpass_fn("Password: ")

        headers = {"apikey": sb_anon, "Content-Type": "application/json"}
        with self._client_factory() as client:
            resp = client.post(
                f"{sb_url}/auth/v1/token?grant_type=password",
                headers=headers,
                json={"email": email, "password": password},
            )
            if resp.status_code != 200:
                raise AuthError(f"Login failed ({resp.status_code}): check email/password.")
            tok_data = resp.json()
            access_token = tok_data["access_token"]
            refresh_token = tok_data["refresh_token"]
            claims = decode_jwt_claims_unverified(access_token)

            if claims.get("aal") != "aal2":
                raw_factors = (tok_data.get("user") or {}).get("factors")
                if not raw_factors:
                    user_resp = client.get(
                        f"{sb_url}/auth/v1/user",
                        headers={"apikey": sb_anon, "Authorization": f"Bearer {access_token}"},
                    )
                    if user_resp.status_code != 200:
                        raise AuthError("Could not retrieve MFA factors for this admin account.")
                    raw_factors = (user_resp.json() or {}).get("factors") or []
                factors = [
                    f for f in raw_factors
                    if f.get("factor_type") == "totp" and f.get("status") == "verified"
                ]
                if not factors:
                    raise AuthError("No verified TOTP authenticator found. Enroll MFA in the admin portal first.")
                factor_id = factors[0]["id"]
                chal_resp = client.post(
                    f"{sb_url}/auth/v1/factors/{factor_id}/challenge",
                    headers={"apikey": sb_anon, "Authorization": f"Bearer {access_token}"},
                    json={},
                )
                if chal_resp.status_code != 200:
                    raise AuthError("Failed to start MFA challenge.")
                challenge_id = chal_resp.json()["id"]
                code = (totp_code if totp_code is not None else input_fn("Authenticator 6-digit code: ")).strip()
                ver_resp = client.post(
                    f"{sb_url}/auth/v1/factors/{factor_id}/verify",
                    headers={"apikey": sb_anon, "Authorization": f"Bearer {access_token}"},
                    json={"challenge_id": challenge_id, "code": code},
                )
                if ver_resp.status_code != 200:
                    raise AuthError("Invalid authenticator code (MFA verification failed).")
                ver_data = ver_resp.json()
                access_token = ver_data["access_token"]
                refresh_token = ver_data.get("refresh_token", refresh_token)

        final_claims, exp = self.validate_aal2(access_token)
        session = RemoteSessionCache(
            api_url=api_url.rstrip("/"),
            supabase_url=sb_url,
            access_token=access_token,
            refresh_token=refresh_token,
            expires_at=exp,
            email=str(final_claims.get("email") or email),
            user_id=str(final_claims.get("sub") or ""),
        )
        self.save_cached_session(session)
        return session

    def refresh_session(
        self,
        session: RemoteSessionCache,
        *,
        supabase_anon_key: Optional[str] = None,
    ) -> RemoteSessionCache:
        sb_url, sb_anon = discover_supabase_config(
            supabase_url=session.supabase_url,
            supabase_anon_key=supabase_anon_key,
        )
        if not sb_url or not sb_anon:
            raise AuthError("Supabase anon key required to refresh cached remote session.")
        with self._client_factory() as client:
            resp = client.post(
                f"{sb_url}/auth/v1/token?grant_type=refresh_token",
                headers={"apikey": sb_anon, "Content-Type": "application/json"},
                json={"refresh_token": session.refresh_token},
            )
            if resp.status_code != 200:
                raise AuthError("Cached session expired; re-authenticate with --login.")
            data = resp.json()
        access_token = data["access_token"]
        refresh_token = data.get("refresh_token", session.refresh_token)
        claims, exp = self.validate_aal2(access_token)
        updated = RemoteSessionCache(
            api_url=session.api_url,
            supabase_url=sb_url,
            access_token=access_token,
            refresh_token=refresh_token,
            expires_at=exp,
            email=str(claims.get("email") or session.email),
            user_id=str(claims.get("sub") or session.user_id),
        )
        self.save_cached_session(updated)
        return updated

    def resolve_token(
        self,
        *,
        api_url: str,
        explicit_token: Optional[str] = None,
        supabase_url: Optional[str] = None,
        supabase_anon_key: Optional[str] = None,
        force_login: bool = False,
    ) -> RemoteSessionCache:
        """Resolve an `aal2` RemoteSessionCache from flag/env, cache, or interactive login."""
        env_token = explicit_token or os.getenv("ETYMOS_ADMIN_TOKEN")
        if env_token:
            claims, exp = self.validate_aal2(env_token.strip())
            return RemoteSessionCache(
                api_url=api_url.rstrip("/"),
                supabase_url=(supabase_url or "").rstrip("/"),
                access_token=env_token.strip(),
                refresh_token="",
                expires_at=exp,
                email=str(claims.get("email") or ""),
                user_id=str(claims.get("sub") or ""),
            )

        if force_login:
            return self.interactive_login(
                api_url=api_url,
                supabase_url=supabase_url,
                supabase_anon_key=supabase_anon_key,
            )

        cached = self.load_cached_session(api_url=api_url)
        if cached is not None:
            if cached.expires_at > time.time() + 120:
                try:
                    self.validate_aal2(cached.access_token)
                    return cached
                except AuthError:
                    pass
            try:
                return self.refresh_session(cached, supabase_anon_key=supabase_anon_key)
            except AuthError:
                pass

        if sys.stdin.isatty():
            return self.interactive_login(
                api_url=api_url,
                supabase_url=supabase_url,
                supabase_anon_key=supabase_anon_key,
            )
        raise AuthError(
            "No valid remote admin session found. Run with `--login` or provide `--token` / `ETYMOS_ADMIN_TOKEN`."
        )
