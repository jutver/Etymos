"""
Database test for supabase/migrations/20261018010000_student_verification_limits.sql:
the student-verification bucket takes photos only, up to 2 MB. Skipped without
pgserver/psycopg, like test_payments_sql.py (whose throwaway database this reuses).
"""
from __future__ import annotations

import pytest

from test_payments_sql import db  # noqa: F401  (fixture)

pytest.importorskip("psycopg")


def test_evidence_bucket_takes_small_photos_only(db):
    limit, types = db.execute(
        "select file_size_limit, allowed_mime_types from storage.buckets where id = 'student-verification'"
    ).fetchone()
    assert limit == 2 * 1024 * 1024
    assert sorted(types) == ["image/jpeg", "image/png", "image/webp"]
