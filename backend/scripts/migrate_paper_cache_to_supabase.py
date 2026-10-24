"""
One-time copy of a server's local paper cache (paper_cache/papers.db and
paper_cache/chunks/*.json, written before the cache moved to Supabase) into
the source_papers and source_paper_chunks tables. PDFs are not uploaded:
papers with a PDF on this server get their full-text chunks built from it if
they have none yet, and the chunks are what's stored.

Safe to run more than once: rows are upserted by paper_id.

    cd backend
    set -a; source .env; set +a
    .venv/bin/python scripts/migrate_paper_cache_to_supabase.py --dry-run
    .venv/bin/python scripts/migrate_paper_cache_to_supabase.py
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND_DIR)
os.chdir(BACKEND_DIR)

import paper_cache  # noqa: E402
import paper_store  # noqa: E402

_WEB_SOURCES = {"DuckDuckGo"}


def _old_rows(db_path: str) -> list[dict]:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(row) for row in conn.execute("SELECT * FROM papers")]
    except sqlite3.OperationalError:
        return []
    finally:
        conn.close()


def _local_chunks(paper_id: str) -> list[dict]:
    path = os.path.join(paper_cache.CHUNKS_DIR, paper_id + ".json")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _abstract_from(chunks: list[dict], title: str) -> str:
    text = " ".join(c.get("text", "") for c in chunks if c.get("section") == "abstract")
    # Abstract-only chunks start with the title (build_fallback_chunks_from_abstract).
    if title and text.startswith(title):
        text = text[len(title):]
    return text.strip()[:4000]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="show what would be copied, write nothing")
    args = parser.parse_args()

    store = paper_cache.get_store()
    if not isinstance(store, paper_store.SupabasePaperStore):
        print("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set: load backend/.env first.")
        return 1

    rows = _old_rows(paper_cache.DB_PATH)
    print(f"{len(rows)} papers in {paper_cache.DB_PATH}")
    counts = {"full_text": 0, "abstract": 0, "metadata_only": 0}

    for row in rows:
        paper_id = row["paper_id"]
        pdf_path = os.path.join(paper_cache.PDF_DIR, paper_id + ".pdf")
        has_pdf = bool(row.get("downloaded")) and os.path.exists(pdf_path)
        chunks = _local_chunks(paper_id)
        chunks_source = "full_text" if row.get("downloaded") and chunks else ("abstract" if chunks else "")

        if has_pdf and not chunks and not args.dry_run:
            # Downloaded but never chunked here: build them before the PDF is the only copy.
            record = {"paper_id": paper_id, "title": row.get("title") or ""}
            store.upsert(record)
            built = paper_cache.build_sections_and_chunks_for_paper(paper_id, pdf_path)
            chunks = _local_chunks(paper_id) if built.get("num_chunks") else []
            chunks_source = "full_text" if chunks else ""

        title = row.get("title") or ""
        record = {
            "paper_id": paper_id,
            "title": title,
            "normalized_title": paper_cache.normalize_title(title),
            "year": row.get("year") or "",
            "doi": row.get("doi") or "",
            "arxiv_id": row.get("arxiv_id") or "",
            "source": row.get("source") or "",
            "source_kind": "web" if row.get("source") in _WEB_SOURCES else "academic",
            "url": row.get("url") or "",
            "pdf_url": row.get("pdf_url") or "",
            "abstract": _abstract_from(chunks, title),
            "has_full_text": chunks_source == "full_text",
            "chunk_version": paper_cache.CHUNK_VERSION if chunks_source == "full_text" else None,
            "pdf_attempted_url": row.get("pdf_url") or "",
            "pdf_attempted_at": None,
        }
        counts[chunks_source or "metadata_only"] += 1
        print(f"  {chunks_source or 'metadata':9} {len(chunks):4} chunks | {title[:70]}")

        if args.dry_run:
            continue

        store.upsert(record)
        if chunks:
            store.save_chunks(paper_id, chunks, chunks_source)

    action = "Would copy" if args.dry_run else "Copied"
    print(f"{action}: {counts['full_text']} with full text, {counts['abstract']} with abstract only, "
          f"{counts['metadata_only']} with metadata only.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
