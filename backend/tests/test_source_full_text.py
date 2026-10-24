# -*- coding: utf-8 -*-
"""
A candidate paper is compared by its full text, not just its abstract:
the search results keep the open-access PDF link through deduplication and
ranking, so paper_cache can download the paper.
"""
import numpy as np

import paper_cache
import paper_store
import similarity
from search_paper import search_openalex, search_semantic_scholar
from search_paper.search_sources import deduplicate_papers


class _Response:
    status_code = 200

    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self.payload


OPENALEX_KIM = {
    "id": "https://openalex.org/W1832693441",
    "title": "Convolutional Neural Networks for Sentence Classification",
    "publication_year": 2014,
    "doi": "https://doi.org/10.3115/v1/d14-1181",
    "abstract_inverted_index": {"We": [0], "report": [1]},
    "open_access": {"is_oa": True, "oa_url": "https://aclanthology.org/D14-1181.pdf"},
    "best_oa_location": {"pdf_url": "https://aclanthology.org/D14-1181.pdf"},
    "locations": [
        {"landing_page_url": "https://doi.org/10.3115/v1/d14-1181", "pdf_url": "https://aclanthology.org/D14-1181.pdf"},
        {"landing_page_url": "https://arxiv.org/abs/1408.5882", "pdf_url": None},
    ],
}


def test_openalex_keeps_the_pdf_link_and_a_bare_doi(monkeypatch):
    monkeypatch.setattr(search_openalex.requests, "get", lambda *a, **k: _Response({"results": [OPENALEX_KIM]}))
    (paper,) = search_openalex.search_openalex("cnn sentence classification", delay_seconds=0)
    assert paper["pdf_url"] == "https://aclanthology.org/D14-1181.pdf"
    assert paper["doi"] == "10.3115/v1/d14-1181"
    assert paper["arxiv_id"] == "1408.5882"


def test_openalex_falls_back_to_the_open_access_page():
    item = {"open_access": {"oa_url": "https://example.org/paper"}, "locations": [{"pdf_url": None}]}
    assert search_openalex.openalex_pdf_url(item) == "https://example.org/paper"
    assert search_openalex.openalex_pdf_url({}) == ""


def test_semantic_scholar_asks_for_and_keeps_the_pdf_link(monkeypatch):
    seen = {}

    def fake_get(url, params=None, timeout=None):
        seen["fields"] = params["fields"]
        return _Response({"data": [{
            "title": "Convolutional Neural Networks for Sentence Classification",
            "externalIds": {"DOI": "10.3115/v1/D14-1181", "ArXiv": "1408.5882", "ACL": "D14-1181"},
            "openAccessPdf": {"url": "https://arxiv.org/pdf/1408.5882"},
            "url": "https://www.semanticscholar.org/paper/1f6ba07",
        }]})

    monkeypatch.setattr(search_semantic_scholar.requests, "get", fake_get)
    (paper,) = search_semantic_scholar.search_semantic_scholar("cnn", delay_seconds=0)
    assert "openAccessPdf" in seen["fields"]
    assert paper["pdf_url"] == "https://arxiv.org/pdf/1408.5882"
    assert (paper["arxiv_id"], paper["acl_id"]) == ("1408.5882", "D14-1181")


def test_one_paper_from_two_sources_is_one_candidate_with_the_pdf_link():
    from_s2 = {"title": "CNN", "doi": "10.3115/v1/D14-1181", "pdf_url": "", "source": "Semantic Scholar"}
    from_openalex = {"title": "CNN", "doi": "10.3115/v1/d14-1181", "pdf_url": "https://aclanthology.org/D14-1181.pdf", "source": "OpenAlex"}
    (paper,) = deduplicate_papers([from_s2, from_openalex])
    assert paper["source"] == "Semantic Scholar"
    assert paper["pdf_url"] == "https://aclanthology.org/D14-1181.pdf"
    assert paper_cache.make_paper_id(from_s2) == paper_cache.make_paper_id(from_openalex)


def test_pdf_link_from_arxiv_or_acl_id():
    assert paper_cache.guess_pdf_url({"arxiv_id": "1408.5882"}) == "https://arxiv.org/pdf/1408.5882"
    assert paper_cache.guess_pdf_url({"acl_id": "D14-1181"}) == "https://aclanthology.org/D14-1181.pdf"
    assert paper_cache.guess_pdf_url({"pdf_url": "https://x/p.pdf", "arxiv_id": "1408.5882"}) == "https://x/p.pdf"
    assert paper_cache.guess_pdf_url({"url": "https://openalex.org/W1"}) == ""


def test_ranking_keeps_the_pdf_link_and_the_whole_abstract(monkeypatch):
    monkeypatch.setattr(similarity, "embed_query", lambda text: np.array([1.0, 0.0]))
    monkeypatch.setattr(similarity, "embed_passage", lambda text: np.array([1.0, 0.0]))
    abstract = "word " * 200
    paper = {"title": "CNN", "abstract": abstract, "pdf_url": "https://aclanthology.org/D14-1181.pdf", "arxiv_id": "1408.5882"}
    (ranked,) = similarity.rank_papers({"abstract": {"text": "section " * 20, "weight": 1.0}}, [paper])
    assert ranked["pdf_url"] == paper["pdf_url"]
    assert ranked["arxiv_id"] == "1408.5882"
    assert ranked["abstract"] == abstract


def _cache_in(tmp_path, monkeypatch):
    monkeypatch.setattr(paper_cache, "CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(paper_cache, "PDF_DIR", str(tmp_path / "pdf"))
    monkeypatch.setattr(paper_cache, "SECTIONS_DIR", str(tmp_path / "sections"))
    monkeypatch.setattr(paper_cache, "CHUNKS_DIR", str(tmp_path / "chunks"))
    monkeypatch.setattr(paper_cache, "DB_PATH", str(tmp_path / "papers.db"))
    monkeypatch.setattr(paper_cache, "_store", paper_store.SqlitePaperStore(str(tmp_path / "papers.db")))
    monkeypatch.setattr(paper_cache, "find_open_access_pdf", lambda paper: "")
    attempts = []

    def fake_download(url, path, paper_page_url=""):
        attempts.append(url)
        return url.endswith(".pdf")

    monkeypatch.setattr(paper_cache, "download_pdf", fake_download)
    return attempts


def test_paper_cached_without_its_pdf_is_downloaded_once_a_link_turns_up(tmp_path, monkeypatch):
    attempts = _cache_in(tmp_path, monkeypatch)
    paper = {"title": "CNN", "doi": "10.3115/v1/d14-1181"}

    assert paper_cache.cache_candidate_paper(paper)["downloaded"] is False
    assert paper_cache.cache_candidate_paper(paper)["status"] == "exists"

    with_link = {**paper, "pdf_url": "https://aclanthology.org/D14-1181.pdf"}
    result = paper_cache.cache_candidate_paper(with_link)
    assert result["status"] == "downloaded"
    assert paper_cache.cache_candidate_paper(with_link)["status"] == "exists"
    assert attempts == ["", "https://aclanthology.org/D14-1181.pdf"]


def test_a_link_that_failed_is_not_retried_every_check(tmp_path, monkeypatch):
    attempts = _cache_in(tmp_path, monkeypatch)
    paper = {"title": "CNN", "doi": "10.1/x", "pdf_url": "https://publisher.example/landing"}
    assert paper_cache.cache_candidate_paper(paper)["downloaded"] is False
    assert paper_cache.cache_candidate_paper(paper)["status"] == "exists"
    assert attempts == ["https://publisher.example/landing"]


def test_api_keys_are_sent_when_configured(monkeypatch):
    seen = {}

    def fake_get(url, params=None, timeout=None, headers=None):
        seen[url] = (params, headers)
        return _Response({"results": [], "data": []})

    monkeypatch.setattr(search_openalex.requests, "get", fake_get)
    monkeypatch.setattr(search_semantic_scholar.requests, "get", fake_get)
    monkeypatch.setattr(search_openalex, "OPENALEX_API_KEY", "oa-key")
    monkeypatch.setattr(search_semantic_scholar, "SEMANTIC_SCHOLAR_API_KEY", "s2-key")

    search_openalex.search_openalex("cnn", delay_seconds=0)
    search_semantic_scholar.search_semantic_scholar("cnn", delay_seconds=0)

    assert seen["https://api.openalex.org/works"][0]["api_key"] == "oa-key"
    assert seen["https://api.semanticscholar.org/graph/v1/paper/search"][1] == {"x-api-key": "s2-key"}
