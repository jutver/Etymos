"""
Where the source-paper cache is kept: every paper a check has found, and the
text chunks the matcher compares against.

With Supabase configured (production) it lives in the source_papers and
source_paper_chunks tables (supabase/migrations/20261024020000_source_papers.sql),
so it survives replacing the API server and is shared by every instance.
Without it (local development, tests) the same records go to SQLite in
paper_cache/papers.db.

Both stores take and return records as plain dicts with the source_papers
columns. PDFs are never stored here; paper_cache keeps them on local disk
only, and the chunks built from them are what's shared.

A store error never fails a check: reads answer "nothing cached", writes are
logged and dropped, and the paper is simply looked up or downloaded again.
"""
from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)

PAPER_FIELDS = (
    "paper_id", "title", "normalized_title", "year", "doi", "arxiv_id", "acl_id",
    "source", "source_kind", "url", "pdf_url", "authors", "abstract",
    "has_full_text", "chunk_version", "pdf_attempted_url", "pdf_attempted_at",
)

# PostgREST puts ids in the URL of an `in` filter; keep each request short.
_IN_BATCH = 50


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_time(value: Any) -> Optional[datetime]:
    """Postgres gives 1-6 fractional digits, which fromisoformat (3.10) rejects
    unless there are 3 or 6."""
    if not value:
        return None
    text = str(value).replace("Z", "+00:00")
    text = re.sub(r"\.(\d+)", lambda m: "." + (m.group(1) + "000000")[:6], text)
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _batches(items: list[str]):
    for i in range(0, len(items), _IN_BATCH):
        yield items[i:i + _IN_BATCH]


class SupabasePaperStore:
    def __init__(self, client):
        self.client = client

    def get_many(self, paper_ids: list[str]) -> dict[str, dict]:
        found: dict[str, dict] = {}
        ids = [p for p in dict.fromkeys(paper_ids) if p]
        try:
            for batch in _batches(ids):
                rows = (
                    self.client.table("source_papers").select(",".join(PAPER_FIELDS))
                    .in_("paper_id", batch).execute().data
                ) or []
                found.update({row["paper_id"]: row for row in rows})
        except Exception:
            logger.exception("Paper store: could not read source_papers.")
        return found

    def upsert(self, record: dict) -> None:
        row = {k: record.get(k) for k in PAPER_FIELDS if k in record}
        row["updated_at"] = now_iso()
        try:
            self.client.table("source_papers").upsert(row, on_conflict="paper_id").execute()
        except Exception:
            logger.exception("Paper store: could not save paper %s.", record.get("paper_id"))

    def save_chunks(self, paper_id: str, chunks: list[dict], chunks_source: str) -> None:
        try:
            self.client.table("source_paper_chunks").upsert({
                "paper_id": paper_id,
                "chunks": chunks,
                "chunks_source": chunks_source,
                "updated_at": now_iso(),
            }, on_conflict="paper_id").execute()
        except Exception:
            logger.exception("Paper store: could not save the chunks of %s.", paper_id)

    def load_chunks(self, paper_id: str) -> Optional[dict]:
        try:
            rows = (
                self.client.table("source_paper_chunks")
                .select("chunks,chunks_source")
                .eq("paper_id", paper_id).limit(1).execute().data
            ) or []
        except Exception:
            logger.exception("Paper store: could not read the chunks of %s.", paper_id)
            return None
        return rows[0] if rows else None

    def search(self, terms: list[str], limit: int) -> list[dict]:
        if not terms:
            return []
        try:
            ranked = self.client.rpc(
                "search_source_papers", {"p_terms": terms, "p_limit": limit}
            ).execute().data or []
        except Exception:
            logger.exception("Paper store: search_source_papers failed.")
            return []
        ids = [row["paper_id"] for row in ranked]
        records = self.get_many(ids)
        return [records[i] for i in ids if i in records]

    def ids_by_normalized_titles(self, normalized_titles: list[str]) -> dict[str, str]:
        found: dict[str, str] = {}
        titles = [t for t in dict.fromkeys(normalized_titles) if t]
        try:
            for batch in _batches(titles):
                rows = (
                    self.client.table("source_papers").select("paper_id,normalized_title")
                    .in_("normalized_title", batch).execute().data
                ) or []
                for row in rows:
                    found.setdefault(row["normalized_title"], row["paper_id"])
        except Exception:
            logger.exception("Paper store: could not look papers up by title.")
        return found


class SqlitePaperStore:
    """The local stand-in, with the same tables as Supabase. Search scores
    word overlap in Python, which is fine at a development cache's size."""

    def __init__(self, db_path: str):
        self.db_path = db_path
        self._lock = threading.Lock()
        self._ready = False

    def _connect(self, create: bool) -> Optional[sqlite3.Connection]:
        if not create and not os.path.exists(self.db_path):
            return None
        if create:
            os.makedirs(os.path.dirname(self.db_path) or ".", exist_ok=True)
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        if create and not self._ready:
            conn.executescript("""
            CREATE TABLE IF NOT EXISTS source_papers (
                paper_id TEXT PRIMARY KEY,
                title TEXT, normalized_title TEXT, year TEXT, doi TEXT, arxiv_id TEXT,
                acl_id TEXT, source TEXT, source_kind TEXT, url TEXT, pdf_url TEXT,
                authors TEXT, abstract TEXT, has_full_text INTEGER DEFAULT 0,
                chunk_version INTEGER, pdf_attempted_url TEXT, pdf_attempted_at TEXT, updated_at TEXT
            );
            CREATE TABLE IF NOT EXISTS source_paper_chunks (
                paper_id TEXT PRIMARY KEY, chunks TEXT, chunks_source TEXT, updated_at TEXT
            );
            """)
            self._ready = True
        return conn

    @staticmethod
    def _record(row: sqlite3.Row) -> dict:
        record = {k: row[k] for k in PAPER_FIELDS}
        record["authors"] = json.loads(record["authors"] or "[]")
        record["has_full_text"] = bool(record["has_full_text"])
        return record

    def _query(self, sql: str, params=()) -> list[sqlite3.Row]:
        conn = self._connect(create=False)
        if conn is None:
            return []
        try:
            return conn.execute(sql, params).fetchall()
        except sqlite3.OperationalError:
            # No such table yet: nothing has been cached.
            return []
        finally:
            conn.close()

    def get_many(self, paper_ids: list[str]) -> dict[str, dict]:
        ids = [p for p in dict.fromkeys(paper_ids) if p]
        if not ids:
            return {}
        rows = self._query(
            f"SELECT * FROM source_papers WHERE paper_id IN ({','.join('?' * len(ids))})", ids
        )
        return {row["paper_id"]: self._record(row) for row in rows}

    def upsert(self, record: dict) -> None:
        row = {k: record.get(k) for k in PAPER_FIELDS if k in record}
        if "authors" in row:
            row["authors"] = json.dumps(row["authors"] or [], ensure_ascii=False)
        if "has_full_text" in row:
            row["has_full_text"] = 1 if row["has_full_text"] else 0
        row["updated_at"] = now_iso()
        cols = list(row)
        updates = ", ".join(f"{c} = excluded.{c}" for c in cols if c != "paper_id")
        with self._lock:
            conn = self._connect(create=True)
            try:
                conn.execute(
                    f"INSERT INTO source_papers ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})"
                    f" ON CONFLICT(paper_id) DO UPDATE SET {updates}",
                    [row[c] for c in cols],
                )
                conn.commit()
            finally:
                conn.close()

    def save_chunks(self, paper_id: str, chunks: list[dict], chunks_source: str) -> None:
        with self._lock:
            conn = self._connect(create=True)
            try:
                conn.execute(
                    "INSERT OR REPLACE INTO source_paper_chunks VALUES (?, ?, ?, ?)",
                    (paper_id, json.dumps(chunks, ensure_ascii=False), chunks_source, now_iso()),
                )
                conn.commit()
            finally:
                conn.close()

    def load_chunks(self, paper_id: str) -> Optional[dict]:
        rows = self._query(
            "SELECT chunks, chunks_source FROM source_paper_chunks WHERE paper_id = ?", (paper_id,)
        )
        if not rows:
            return None
        row = rows[0]
        return {"chunks": json.loads(row["chunks"] or "[]"), "chunks_source": row["chunks_source"]}

    def search(self, terms: list[str], limit: int) -> list[dict]:
        wanted = set(terms)
        if not wanted:
            return []
        scored = []
        for row in self._query("SELECT * FROM source_papers"):
            title_words = set(re.findall(r"[^\W_]+", (row["title"] or "").lower()))
            abstract_words = set(re.findall(r"[^\W_]+", (row["abstract"] or "").lower()))
            score = 2 * len(wanted & title_words) + len(wanted & abstract_words)
            if score:
                scored.append((score, row))
        scored.sort(key=lambda item: item[0], reverse=True)
        return [self._record(row) for _score, row in scored[:limit]]

    def ids_by_normalized_titles(self, normalized_titles: list[str]) -> dict[str, str]:
        titles = [t for t in dict.fromkeys(normalized_titles) if t]
        if not titles:
            return {}
        rows = self._query(
            f"SELECT paper_id, normalized_title FROM source_papers"
            f" WHERE normalized_title IN ({','.join('?' * len(titles))})", titles
        )
        found: dict[str, str] = {}
        for row in rows:
            found.setdefault(row["normalized_title"], row["paper_id"])
        return found


def make_store(db_path: str):
    try:
        from api.supabase_client import get_client
        client = get_client()
    except Exception:
        logger.exception("Paper store: Supabase client unavailable; using SQLite.")
        client = None
    return SupabasePaperStore(client) if client is not None else SqlitePaperStore(db_path)
