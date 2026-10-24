# -*- coding: utf-8 -*-
"""
The source-paper cache lives in a store (Supabase in production, SQLite here),
not on one server's disk: a new server reuses the chunks earlier checks built,
checks search the papers earlier checks found, and a paper whose PDF failed
gets another try.
"""
import os
import shutil
from datetime import datetime, timedelta, timezone

import pytest

import paper_cache
import paper_store
from search_paper import search_arxiv, search_sources

KIM = {
    "title": "Convolutional Neural Networks for Sentence Classification",
    "doi": "10.3115/v1/d14-1181",
    "abstract": "We report on a series of experiments with convolutional neural networks trained on top of word vectors.",
    "pdf_url": "https://aclanthology.org/D14-1181.pdf",
    "source": "OpenAlex",
    "source_kind": "academic",
}

SECTIONS = {
    "title": KIM["title"],
    "abstract": KIM["abstract"] + " " + "abstract words " * 10,
    "method": "The model architecture is a slight variant of the CNN architecture. " * 20,
}


@pytest.fixture
def cache(tmp_path, monkeypatch):
    """A cache on tmp_path whose downloads 'succeed' for .pdf links."""
    monkeypatch.setattr(paper_cache, "CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(paper_cache, "PDF_DIR", str(tmp_path / "pdf"))
    monkeypatch.setattr(paper_cache, "SECTIONS_DIR", str(tmp_path / "sections"))
    monkeypatch.setattr(paper_cache, "CHUNKS_DIR", str(tmp_path / "chunks"))
    store = paper_store.SqlitePaperStore(str(tmp_path / "store.db"))
    monkeypatch.setattr(paper_cache, "_store", store)
    monkeypatch.setattr(paper_cache, "find_open_access_pdf", lambda paper: "")
    monkeypatch.setattr(paper_cache, "extract_sections_from_pdf", lambda path: dict(SECTIONS))
    downloads = []

    def fake_download(url, path, paper_page_url=""):
        downloads.append(url)
        if not url.endswith(".pdf"):
            return False
        with open(path, "wb") as f:
            f.write(b"%PDF fake")
        return True

    monkeypatch.setattr(paper_cache, "download_pdf", fake_download)
    return store, downloads, tmp_path


def _new_server(tmp_path):
    """Everything on this server's disk is gone; only the store remains."""
    for folder in ("pdf", "chunks", "sections"):
        shutil.rmtree(tmp_path / folder, ignore_errors=True)


def test_full_text_chunks_outlive_the_server(cache):
    store, downloads, tmp_path = cache
    (first,) = paper_cache.cache_candidate_papers([KIM])
    assert first["status"] == "downloaded" and first["num_chunks"] > 0
    paper_id = first["paper_id"]
    record = store.get_many([paper_id])[paper_id]
    assert record["has_full_text"] and record["chunk_version"] == paper_cache.CHUNK_VERSION
    assert store.load_chunks(paper_id)["chunks_source"] == "full_text"

    _new_server(tmp_path)
    (again,) = paper_cache.cache_candidate_papers([KIM])
    # No new download: the chunks come from the store and are saved locally.
    assert downloads == [KIM["pdf_url"]]
    assert again["chunks_source"] == "full_text"
    assert again["num_chunks"] == first["num_chunks"]
    assert os.path.exists(again["chunks_path"])


def test_matcher_and_quick_check_find_chunks_this_server_never_built(cache):
    from plagiarism_matcher import load_candidate_chunks
    import quick_check

    store, _downloads, tmp_path = cache
    (first,) = paper_cache.cache_candidate_papers([KIM])
    _new_server(tmp_path)

    chunks = load_candidate_chunks([{"paper_id": first["paper_id"], "title": KIM["title"]}])
    assert chunks and chunks[0]["source_paper_id"] == first["paper_id"]
    assert quick_check._paper_ids_by_title({KIM["title"]}) == {KIM["title"]: first["paper_id"]}


def test_old_chunks_are_rebuilt_while_the_pdf_is_here(cache, monkeypatch):
    store, downloads, _tmp = cache
    (first,) = paper_cache.cache_candidate_papers([KIM])
    monkeypatch.setattr(paper_cache, "CHUNK_VERSION", paper_cache.CHUNK_VERSION + 1)
    (again,) = paper_cache.cache_candidate_papers([KIM])
    assert again["sections_built"] is True
    assert store.get_many([first["paper_id"]])[first["paper_id"]]["chunk_version"] == paper_cache.CHUNK_VERSION
    assert downloads == [KIM["pdf_url"]]


def test_a_later_result_never_blanks_out_cached_metadata(cache):
    store, _downloads, _tmp = cache
    paper_cache.cache_candidate_papers([{**KIM, "pdf_url": "https://x/landing"}])
    thin = {"title": KIM["title"], "doi": KIM["doi"]}
    paper_cache.cache_candidate_papers([thin])
    record = store.get_many([paper_cache.make_paper_id(thin)])[paper_cache.make_paper_id(thin)]
    assert record["abstract"] == KIM["abstract"]
    assert record["source"] == "OpenAlex"


def test_a_failed_pdf_is_tried_again_once_the_attempt_is_old(cache):
    store, downloads, _tmp = cache
    paper = {**KIM, "pdf_url": "https://x/landing"}
    paper_cache.cache_candidate_paper(paper)
    assert paper_cache.cache_candidate_paper(paper)["status"] == "exists"
    assert downloads == ["https://x/landing"]

    paper_id = paper_cache.make_paper_id(paper)
    old = (datetime.now(timezone.utc) - timedelta(days=paper_cache.PDF_RETRY_DAYS + 1)).isoformat()
    store.upsert({"paper_id": paper_id, "pdf_attempted_at": old})
    paper_cache.cache_candidate_paper(paper)
    assert downloads == ["https://x/landing", "https://x/landing"]


def test_a_paper_without_a_link_is_looked_up_by_doi(cache, monkeypatch):
    _store, downloads, _tmp = cache
    monkeypatch.setattr(paper_cache, "find_open_access_pdf", lambda paper: "https://oa.example/kim.pdf")
    result = paper_cache.cache_candidate_paper({"title": KIM["title"], "doi": KIM["doi"]})
    assert result["status"] == "downloaded"
    assert downloads == ["https://oa.example/kim.pdf"]


def test_cached_papers_are_found_by_the_check_queries(cache):
    paper_cache.cache_candidate_papers([KIM, {"title": "Attention Is All You Need", "abstract": "transformer " * 20}])
    found = paper_cache.search_cached_papers(["convolutional neural networks sentence classification"])
    assert [p["title"] for p in found] == [KIM["title"]]
    assert found[0]["from_cache"] and found[0]["doi"] == KIM["doi"]
    assert paper_cache.search_cached_papers(["the and with"]) == []


def test_search_terms_drop_stopwords_numbers_and_repeats():
    assert paper_cache.search_terms(["CNN for the sentence classification 2014", "sentence models"]) == [
        "cnn", "sentence", "classification", "models",
    ]


def test_cached_paper_comes_first_and_absorbs_the_same_paper_from_arxiv(monkeypatch):
    cached = {**KIM, "from_cache": True}
    from_arxiv = {"title": KIM["title"], "url": "https://arxiv.org/abs/1408.5882", "arxiv_id": "1408.5882",
                  "doi": "", "abstract": "x", "source": "arXiv"}
    monkeypatch.setattr(search_sources, "_search_cache", lambda queries: [dict(cached)])
    monkeypatch.setattr(search_sources, "search_semantic_scholar", lambda q, max_results: [])
    monkeypatch.setattr(search_sources, "search_openalex", lambda q, max_results: [])
    monkeypatch.setattr(search_sources, "search_duckduckgo", lambda q, max_results: [])
    asked = []

    def fake_arxiv(q, max_results, max_retries):
        asked.append(q)
        return [dict(from_arxiv)]

    monkeypatch.setattr(search_sources, "search_arxiv", fake_arxiv)
    (paper,) = search_sources.search_all_sources(["cnn sentence classification"])
    assert asked == ["cnn sentence classification"]
    assert paper["from_cache"] and paper["doi"] == KIM["doi"]
    assert paper["arxiv_id"] == "1408.5882"
    assert paper_cache.make_paper_id(paper) == paper_cache.make_paper_id(KIM)


def test_arxiv_is_only_asked_when_the_academic_apis_find_nothing(monkeypatch):
    monkeypatch.setattr(search_sources, "_search_cache", lambda queries: [])
    monkeypatch.setattr(search_sources, "search_semantic_scholar", lambda q, max_results: [dict(KIM)])
    monkeypatch.setattr(search_sources, "search_openalex", lambda q, max_results: [])
    monkeypatch.setattr(search_sources, "search_duckduckgo", lambda q, max_results: [])
    monkeypatch.setattr(search_sources, "search_arxiv", lambda *a, **k: pytest.fail("arXiv asked"))
    assert len(search_sources.search_all_sources(["cnn"])) == 1


def test_short_generic_titles_are_not_merged():
    a = {"title": "Introduction", "url": "https://a.example"}
    b = {"title": "Introduction", "url": "https://b.example"}
    assert len(search_sources.deduplicate_papers([a, b])) == 2


def test_arxiv_query_ands_the_first_content_words():
    assert search_arxiv.arxiv_search_query("the movie review classification for sentiment analysis") == (
        "all:movie+AND+all:review+AND+all:classification+AND+all:sentiment"
    )
    assert search_arxiv.arxiv_id_from_url("http://arxiv.org/abs/1408.5882v2") == "1408.5882"
    assert search_arxiv.arxiv_id_from_url("http://arxiv.org/abs/cs/0101001v1") == "cs/0101001"


def test_store_errors_never_fail_a_check():
    class Broken:
        def table(self, name):
            raise RuntimeError("down")

        def rpc(self, *a, **k):
            raise RuntimeError("down")

    store = paper_store.SupabasePaperStore(Broken())
    assert store.get_many(["x"]) == {}
    assert store.load_chunks("x") is None
    assert store.search(["cnn"], 5) == []
    assert store.ids_by_normalized_titles(["cnn"]) == {}
    store.upsert({"paper_id": "x"})
    store.save_chunks("x", [], "abstract")


def test_postgres_timestamps_with_any_fraction_parse():
    assert paper_store.parse_time("2026-10-24T04:25:00.12345+00:00").microsecond == 123450
    assert paper_store.parse_time("") is None
    assert paper_store.parse_time("garbage") is None


def test_old_server_cache_is_copied_into_the_store(cache, monkeypatch):
    import importlib
    import json
    import sqlite3
    import sys

    store, _downloads, tmp_path = cache
    old_db = tmp_path / "papers.db"
    conn = sqlite3.connect(old_db)
    conn.execute("CREATE TABLE papers (paper_id TEXT PRIMARY KEY, title TEXT, year TEXT, doi TEXT, arxiv_id TEXT,"
                 " source TEXT, url TEXT, pdf_url TEXT, pdf_path TEXT, sections_path TEXT, downloaded INTEGER,"
                 " created_at TEXT)")
    conn.execute("INSERT INTO papers VALUES ('full', 'Kim CNN', '2014', '10.1/x', '', 'OpenAlex', 'u', 'p.pdf', '',"
                 " '', 1, '')")
    conn.execute("INSERT INTO papers VALUES ('web', 'A web page', '', '', '', 'DuckDuckGo', 'w', '', '', '', 0, '')")
    conn.commit()
    conn.close()
    os.makedirs(tmp_path / "chunks")
    (tmp_path / "chunks" / "full.json").write_text(json.dumps(
        [{"section": "abstract", "text": "We report experiments."}, {"section": "method", "text": "CNN."}]))
    (tmp_path / "chunks" / "web.json").write_text(json.dumps(
        [{"section": "abstract", "text": "A web page\nsnippet text"}]))

    class FakeSupabase(paper_store.SupabasePaperStore):
        def __getattribute__(self, name):
            if name in ("get_many", "upsert", "save_chunks", "load_chunks", "search", "ids_by_normalized_titles"):
                return getattr(store, name)
            return object.__getattribute__(self, name)

    monkeypatch.setattr(paper_cache, "_store", FakeSupabase(None))
    monkeypatch.setattr(paper_cache, "DB_PATH", str(old_db))
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), "scripts"))
    cwd = os.getcwd()
    try:
        migrate = importlib.import_module("migrate_paper_cache_to_supabase")
        monkeypatch.setattr(sys, "argv", ["migrate"])
        assert migrate.main() == 0
    finally:
        os.chdir(cwd)
        sys.path.pop(0)

    records = store.get_many(["full", "web"])
    assert records["full"]["has_full_text"] and records["full"]["abstract"] == "We report experiments."
    assert records["web"]["source_kind"] == "web" and not records["web"]["has_full_text"]
    assert records["web"]["abstract"] == "snippet text"
    assert store.load_chunks("full")["chunks_source"] == "full_text"
    assert store.load_chunks("web")["chunks_source"] == "abstract"


def test_the_document_title_is_searched_when_it_looks_like_one():
    from llm_metadata import title_search_query

    assert title_search_query("Convolutional Neural  Networks\nfor Sentence Classification") == (
        "Convolutional Neural Networks for Sentence Classification"
    )
    assert title_search_query("Report") == ""
    assert title_search_query("word " * 40) == ""
