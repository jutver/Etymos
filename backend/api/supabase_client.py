"""
supabase_client.py
-------------------
Single shared Supabase client for the backend, built from the
service-role key. Server-only — this key must never be shipped to any
frontend (it bypasses Row Level Security).

Other backend modules should import `get_client()` (or the module-level
`supabase` singleton) rather than constructing their own client.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

from supabase import Client, create_client

logger = logging.getLogger(__name__)

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

_client: Optional[Client] = None
_warned = False


def get_client() -> Optional[Client]:
    """
    Return the shared service-role Supabase client, or None if the
    required env vars are not configured.

    Returning None (rather than raising) lets callers degrade gracefully
    (e.g. fall back to local/in-memory storage) in local dev environments
    that don't have Supabase credentials configured, while still failing
    loudly via logs.
    """
    global _client, _warned

    if _client is not None:
        return _client

    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        if not _warned:
            logger.warning(
                "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — "
                "Supabase-backed features (persistence, storage, feature "
                "flags, account deletion) are disabled."
            )
            _warned = True
        return None

    _client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    return _client


# Module-level singleton for convenience: `from supabase_client import supabase`
# NOTE: this is evaluated at import time. Prefer `get_client()` in code paths
# that might run before env vars are loaded, since it re-checks lazily.
supabase = get_client()
