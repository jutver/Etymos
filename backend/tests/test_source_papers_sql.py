"""
Database tests for supabase/migrations/20261024020000_source_papers.sql: only
the backend can read or write the cached papers and their text, and
search_source_papers ranks papers by the words they share with a check's
queries. Skipped without pgserver/psycopg, like test_document_unlock_sql.py.
"""
from __future__ import annotations

import json

import pytest

pytest.importorskip("pgserver")
psycopg = pytest.importorskip("psycopg")

from test_document_unlock_sql import as_service  # noqa: E402
from test_payments_sql import as_user, make_user  # noqa: E402
from test_user_activity_log_sql import db  # noqa: E402,F401

INSERT = "insert into public.source_papers (paper_id, title, abstract) values (%s, %s, %s) returning paper_id"


def _search(db, terms, limit=15):
    return [row[0] for row in as_service(db, "select paper_id from public.search_source_papers(%s, %s)", (terms, limit))]


def test_the_backend_ranks_papers_by_shared_words(db):
    as_service(db, INSERT, ("kim", "Convolutional Neural Networks for Sentence Classification",
                            "We report on experiments with convolutional neural networks."))
    as_service(db, INSERT, ("other", "Sentence embeddings", "A survey of convolutional models."))
    as_service(db, INSERT, ("unrelated", "Protein folding", "Biology."))

    assert _search(db, ["convolutional", "sentence", "classification"]) == ["kim", "other"]
    assert _search(db, ["convolutional"], limit=1) == ["kim"]
    # Punctuation-only or empty terms are ignored rather than failing.
    assert _search(db, ["", "!!", "protein"]) == ["unrelated"]
    assert _search(db, []) == []


def test_chunks_are_stored_per_paper_and_go_with_it(db):
    as_service(db, INSERT, ("with-chunks", "A paper", ""))
    chunks = [{"paper_id": "with-chunks", "section": "method", "text": "words"}]
    as_service(db, "insert into public.source_paper_chunks (paper_id, chunks, chunks_source) values (%s, %s, 'full_text') returning paper_id",
               ("with-chunks", json.dumps(chunks)))
    with pytest.raises(psycopg.errors.CheckViolation):
        as_service(db, "insert into public.source_paper_chunks (paper_id, chunks_source) values (%s, 'pdf') returning paper_id", ("with-chunks",))
    as_service(db, "delete from public.source_papers where paper_id = 'with-chunks' returning paper_id")
    assert as_service(db, "select paper_id from public.source_paper_chunks where paper_id = 'with-chunks'") == []


def test_users_can_neither_read_nor_search_the_cache(db):
    as_service(db, INSERT, ("private", "Private paper", "full text of someone else's paper"))
    user = make_user(db)
    for sql in ("select * from public.source_papers", "select * from public.source_paper_chunks",
                "select * from public.search_source_papers(array['private'], 5)"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_user(db, user, sql)
