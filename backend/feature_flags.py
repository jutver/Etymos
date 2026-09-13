"""
feature_flags.py
----------------
Shared reader for `public.feature_flags` (see
supabase/migrations/20260715120400_feature_flags_and_announcements.sql).

This generalizes the flag-reading logic that previously lived inline in
llm_metadata.is_gemini_metadata_extraction_enabled(), so every backend
toggle behaves identically:

  * one short-lived in-process cache (env FEATURE_FLAG_CACHE_TTL_SECONDS,
    default 45s) so we don't hit the DB on every call,
  * a safe default when the flag row is missing, unreadable, or Supabase
    isn't configured in this environment.

It also provides `ensure_flag_registered()`, which upserts a flag row so
the admin portal's Feature Flags screen (which lists whatever rows exist)
can show and toggle a backend flag without requiring a new SQL migration.
"""

from __future__ import annotations

import logging
import os
import threading
import time

from api.supabase_client import get_client

logger = logging.getLogger(__name__)

FLAG_CACHE_TTL_SECONDS = float(os.getenv("FEATURE_FLAG_CACHE_TTL_SECONDS", "45"))

_cache: dict[str, tuple[float, bool]] = {}
_cache_lock = threading.Lock()

_registered: set[str] = set()
_register_lock = threading.Lock()


def is_flag_enabled(key: str, default: bool = False) -> bool:
    """
    Return the boolean value of feature flag `key`, cached for
    FLAG_CACHE_TTL_SECONDS. Falls back to `default` whenever the flag
    cannot be read (no Supabase credentials, missing row, network error).
    """
    now = time.time()

    with _cache_lock:
        cached = _cache.get(key)
        if cached is not None and (now - cached[0]) < FLAG_CACHE_TTL_SECONDS:
            return cached[1]

    client = get_client()
    value = default

    if client is not None:
        try:
            resp = (
                client.table("feature_flags")
                .select("enabled")
                .eq("key", key)
                .maybe_single()
                .execute()
            )
            if resp and resp.data:
                value = bool(resp.data.get("enabled", default))
        except Exception:
            logger.exception(
                "Failed to read feature flag %s; falling back to default=%s.",
                key,
                default,
            )
            value = default

    with _cache_lock:
        _cache[key] = (now, value)

    return value


def invalidate_flag_cache(key: str | None = None) -> None:
    """Drop the cached value for `key` (or the whole cache when None)."""
    with _cache_lock:
        if key is None:
            _cache.clear()
        else:
            _cache.pop(key, None)


def ensure_flag_registered(
    key: str,
    label: str,
    description: str,
    default_enabled: bool = False,
) -> bool:
    """
    Insert the flag row if it does not exist yet, so admins can see and
    toggle it in the admin portal's Config → Feature Flags screen.

    Never overwrites an existing row (the admin's chosen value always
    wins) and never raises — a backend that can't reach Supabase simply
    keeps using the code-level default. Runs at most once per process
    per key.
    """
    with _register_lock:
        if key in _registered:
            return False
        _registered.add(key)

    client = get_client()
    if client is None:
        return False

    try:
        client.table("feature_flags").upsert(
            {
                "key": key,
                "label": label,
                "description": description,
                "enabled": default_enabled,
            },
            on_conflict="key",
            ignore_duplicates=True,
        ).execute()
        return True
    except Exception:
        logger.warning(
            "Could not register feature flag %s (it may already exist, or "
            "Supabase is unreachable). The backend will keep using its "
            "code-level default.",
            key,
            exc_info=True,
        )
        return False
