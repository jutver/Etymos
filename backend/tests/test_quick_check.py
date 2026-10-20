"""
Tests for quick_check: the "check nhanh" run on one rewritten / hand-edited
passage against the sources the report already found.

The embedding model is replaced by a stub so these run without a GPU/model:
semantic similarity is derived from word overlap, which is enough to exercise
classify_sentence_match()'s thresholds.
"""

import json

import pytest

import quick_check
from plagiarism_matcher import word_jaccard_similarity

SOURCE_A = (
    "Convolutional neural networks have achieved remarkable performance on large scale "
    "image classification benchmarks over the last decade."
)
SOURCE_B = (
    "Transformer models rely on self attention to capture long range dependencies "
    "between tokens in a sequence."
)


@pytest.fixture(autouse=True)
def stub_embedder(monkeypatch):
    # cosine(query(a), passage(b)) == 0.5 + word overlap, capped at 1: identical
    # wording scores high, unrelated wording scores low. Every model call is
    # recorded so tests can check batching.
    class Vec:
        def __init__(self, text):
            self.text = text.split(": ", 1)[1]

    calls = []

    def fake_encode(texts):
        calls.append(list(texts))
        return [Vec(t) for t in texts]

    def fake_cosine(a, b):
        return min(1.0, 0.5 + word_jaccard_similarity(a.text, b.text))

    monkeypatch.setattr(quick_check, "_encode", fake_encode)
    monkeypatch.setattr(quick_check, "_cosine", fake_cosine)
    quick_check._CORPUS_CACHE.clear()
    quick_check._EMBED_CACHE.clear()
    return calls


def _corpus():
    return [
        {"text": SOURCE_A, "source_paper_id": "paper_a", "source_title": "Paper A"},
        {"text": SOURCE_B, "source_paper_id": "paper_b", "source_title": "Paper B"},
    ]


def test_copied_sentence_is_flagged_against_its_source():
    result = quick_check.check_passage(SOURCE_A, _corpus())
    assert result["status"] == "flagged"
    assert result["hits"][0]["source_title"] == "Paper A"
    assert result["hits"][0]["label"] == "likely_plagiarism"


def test_rewrite_that_copies_a_different_source_is_flagged_against_that_source():
    # The rewrite fixed the overlap with Paper A but lifted Paper B instead.
    result = quick_check.check_passage(SOURCE_B, _corpus())
    assert result["status"] == "flagged"
    assert result["hits"][0]["source_paper_id"] == "paper_b"


def test_genuinely_reworded_passage_is_clean():
    rewritten = (
        "Over the past ten years, deep vision models built from stacked filters "
        "have reached very strong accuracy when sorting photographs into categories."
    )
    result = quick_check.check_passage(rewritten, _corpus())
    assert result["status"] == "clean"
    assert result["hits"] == []


def test_one_hit_per_sentence_for_multi_sentence_passages():
    result = quick_check.check_passage(SOURCE_A + " " + SOURCE_B, _corpus())
    assert result["checked_sentences"] == 2
    assert {h["source_paper_id"] for h in result["hits"]} == {"paper_a", "paper_b"}


def test_empty_text_is_clean():
    assert quick_check.check_passage("   ", _corpus())["status"] == "clean"


def test_corpus_reads_chunk_files_and_falls_back_to_match_sentences(tmp_path, monkeypatch):
    chunks_dir = tmp_path / "chunks"
    chunks_dir.mkdir()
    (chunks_dir / "paper_a.json").write_text(
        json.dumps([{"paper_id": "paper_a", "text": SOURCE_A + " Another unrelated sentence about cooking pasta at home."}]),
        encoding="utf-8",
    )
    monkeypatch.setattr(quick_check, "CHUNKS_DIR", str(chunks_dir))
    monkeypatch.setattr(quick_check, "_paper_ids_by_title", lambda titles: {})

    report = {
        "matches": [
            # Chunks on disk for this one...
            {"source_paper_id": "paper_a", "source_title": "Paper A", "source_sentence": SOURCE_A},
            # ...but not for this one (e.g. restored from Supabase): its matched
            # sentence is still in the corpus.
            {"source_title": "Paper B", "source_snippet": SOURCE_B},
        ]
    }
    corpus = quick_check.build_source_corpus(report)
    texts = [e["text"] for e in corpus]
    assert SOURCE_A in texts
    assert SOURCE_B in texts
    assert any("cooking pasta" in t for t in texts)
    # SOURCE_A came from both the chunk and the match: kept once.
    assert texts.count(SOURCE_A) == 1


def test_report_corpus_is_cached_per_report(monkeypatch):
    calls = []

    def fake_build(report):
        calls.append(1)
        return _corpus()

    monkeypatch.setattr(quick_check, "build_source_corpus", fake_build)
    quick_check.quick_check_report_passage("r1", {}, SOURCE_A)
    quick_check.quick_check_report_passage("r1", {}, SOURCE_B)
    assert len(calls) == 1


# --- POST /api/reports/{id}/quick-check ---------------------------------------

@pytest.fixture
def api_client(monkeypatch):
    from fastapi.testclient import TestClient

    import app as api_app
    from auth import AuthedUser, verify_supabase_jwt

    api_app.app.dependency_overrides[verify_supabase_jwt] = lambda: AuthedUser(user_id="user-1", email=None, role="user", is_admin=False)
    api_app.limiter.enabled = False
    yield api_app, TestClient(api_app.app)
    api_app.app.dependency_overrides.clear()
    api_app.limiter.enabled = True


def test_endpoint_checks_against_the_reports_sources(api_client, monkeypatch):
    api_app, client = api_client
    report = {"user_id": "user-1", "matches": [{"source_title": "Paper A", "source_sentence": SOURCE_A}]}
    monkeypatch.setattr(api_app, "get_report", lambda rid: report)
    monkeypatch.setattr(api_app, "get_local_report_file", lambda rid: None)
    quick_check._CORPUS_CACHE.clear()

    res = client.post("/api/reports/r-1/quick-check", json={"text": SOURCE_A})
    assert res.status_code == 200
    assert res.json()["status"] == "flagged"
    assert res.json()["hits"][0]["source_title"] == "Paper A"


def test_endpoint_hides_someone_elses_report(api_client, monkeypatch):
    api_app, client = api_client
    monkeypatch.setattr(api_app, "get_report", lambda rid: {"user_id": "someone-else", "matches": []})
    res = client.post("/api/reports/r-2/quick-check", json={"text": SOURCE_A})
    assert res.status_code == 404  # 404, not 403: ids can't be probed


def test_endpoint_falls_back_to_client_sources_when_report_is_unknown(api_client, monkeypatch):
    api_app, client = api_client
    monkeypatch.setattr(api_app, "get_report", lambda rid: None)

    assert client.post("/api/reports/r-3/quick-check", json={"text": SOURCE_B}).status_code == 404
    res = client.post(
        "/api/reports/r-3/quick-check",
        json={"text": SOURCE_B, "sources": [{"title": "Paper B", "text": SOURCE_B}]},
    )
    assert res.status_code == 200
    assert res.json()["status"] == "flagged"
    assert res.json()["hits"][0]["source_title"] == "Paper B"


def test_endpoint_rejects_oversized_text(api_client):
    _, client = api_client
    res = client.post("/api/reports/r-4/quick-check", json={"text": "a" * (quick_check.MAX_QUICK_CHECK_CHARS + 1)})
    assert res.status_code == 422


# --- speed-ups must not change any verdict -----------------------------------

@pytest.mark.parametrize("a,b", [
    (SOURCE_A, SOURCE_B),
    (SOURCE_A, SOURCE_A),
    ("Tiếng Việt có dấu: mô hình đạt kết quả tốt.", "Mô hình đạt kết quả rất tốt trên tập dữ liệu."),
    ("abc", "abcd"),
    ("", SOURCE_A),
])
def test_precomputed_overlaps_equal_the_pipelines_functions(a, b):
    from plagiarism_matcher import char_ngram_jaccard

    wa, ga = quick_check._features(a)
    wb, gb = quick_check._features(b)
    assert quick_check._jaccard(wa, wb) == pytest.approx(word_jaccard_similarity(a, b))
    assert quick_check._jaccard(ga, gb) == pytest.approx(char_ngram_jaccard(a, b))


def test_one_model_call_per_check_and_source_embeddings_are_reused(stub_embedder):
    near_a = (
        "Convolutional neural networks achieved remarkable results on big image "
        "classification benchmarks in the past decade, researchers report."
    )
    corpus = quick_check.build_source_corpus({"matches": [{"source_title": "Paper A", "source_sentence": SOURCE_A}]})
    quick_check.check_passage(near_a + " " + near_a.replace("researchers", "authors"), corpus)
    assert len(stub_embedder) == 1  # both sentences, one batched call
    assert sum(t.startswith("passage: ") for t in stub_embedder[0]) == 1  # SOURCE_A embedded once

    quick_check.check_passage(near_a.replace("report", "say"), corpus)
    assert len(stub_embedder) == 2
    assert not any(t.startswith("passage: ") for t in stub_embedder[1])  # cached


def test_overlap_alone_settles_near_copies_without_the_model(stub_embedder):
    assert quick_check.check_passage(SOURCE_A, _corpus())["status"] == "flagged"
    assert stub_embedder == []


def test_warm_up_builds_the_corpus_and_loads_the_model(stub_embedder, monkeypatch):
    monkeypatch.setattr(quick_check, "build_source_corpus", lambda report: _corpus())
    quick_check.warm_up("r-warm", {})
    assert "r-warm" in quick_check._CORPUS_CACHE
    assert len(stub_embedder) == 1


def test_warm_up_never_raises(monkeypatch):
    def boom(report):
        raise RuntimeError("disk gone")

    monkeypatch.setattr(quick_check, "build_source_corpus", boom)
    quick_check.warm_up("r-broken", {})  # logged, not raised


def test_warm_endpoint_starts_the_warm_up_for_the_owner(api_client, monkeypatch):
    api_app, client = api_client
    monkeypatch.setattr(api_app, "get_report", lambda rid: {"user_id": "user-1", "matches": []})
    monkeypatch.setattr(api_app, "get_local_report_file", lambda rid: None)
    started = []
    monkeypatch.setattr(api_app, "warm_up_quick_check", lambda rid, report: started.append(rid))

    res = client.post("/api/reports/r-5/quick-check/warm")
    assert res.status_code == 202
    assert res.json() == {"status": "warming"}
    import time
    for _ in range(50):
        if started:
            break
        time.sleep(0.01)
    assert started == ["r-5"]


def test_warm_endpoint_hides_someone_elses_report(api_client, monkeypatch):
    api_app, client = api_client
    monkeypatch.setattr(api_app, "get_report", lambda rid: {"user_id": "someone-else", "matches": []})
    assert client.post("/api/reports/r-6/quick-check/warm").status_code == 404
