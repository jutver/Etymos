"""
End-to-end wiring test for match localization, with the embedding model
stubbed out.

This covers the link the unit tests can't: that a chunk's
`doc_start_char` actually survives match_chunks -> verify_all_matches ->
build_final_report and comes out the other side as an absolute
`input_offset` that resolves inside `report["input_text"]`.

The embedding model is replaced with a deterministic character-histogram
vectorizer. Nothing here depends on real semantics: the assertions are
about offsets, and the fixture uses a verbatim-copied sentence so the
match is decided by word overlap.
"""

import sys
import types

import numpy as np


def _fake_embed(text):
    """Deterministic 128-dim character histogram; identical strings give
    a cosine similarity of exactly 1.0."""
    vector = np.zeros(128, dtype=float)
    for char in (text or "").lower():
        code = ord(char)
        if code < 128:
            vector[code] += 1.0
    norm = np.linalg.norm(vector)
    return (vector / norm if norm else vector).tolist()


if "embedding_model" not in sys.modules:
    _stub = types.ModuleType("embedding_model")
    _stub.embed_query = _fake_embed
    _stub.embed_passage = _fake_embed
    sys.modules["embedding_model"] = _stub

import plagiarism_matcher  # noqa: E402
import sentence_matcher  # noqa: E402
from document_model import build_document  # noqa: E402
from extractor import build_chunks_from_sections  # noqa: E402
from final_report_builder import build_final_report  # noqa: E402


COPIED = (
    "Transformer architectures have fundamentally reshaped the landscape of "
    "modern natural language processing research."
)

SECTIONS = {
    "title": "On Copied Sentences",
    "abstract": (
        "We begin with an opening statement that belongs entirely to us and nobody else. "
        + COPIED
        + " We close with another original remark of our own making here."
    ),
    "introduction": (
        "Wholly independent prose fills this introduction from beginning to end. "
        "It borrows nothing whatsoever and simply describes our own contributions."
    ),
}


def _run_pipeline(monkeypatch):
    for module in (plagiarism_matcher, sentence_matcher):
        monkeypatch.setattr(module, "embed_query", _fake_embed, raising=False)
        monkeypatch.setattr(module, "embed_passage", _fake_embed, raising=False)

    document = build_document(SECTIONS)

    input_chunks = build_chunks_from_sections(
        SECTIONS,
        paper_id="input_paper",
        section_offsets=document["section_offsets"],
    )

    candidate_chunks = [{
        "chunk_id": "src_abstract_0",
        "section": "abstract",
        "source_paper_id": "source_paper_1",
        "source_title": "The Original Paper",
        "source_url": "https://example.org/original",
        "source_pdf_url": "",
        "text": (
            "Some preamble sentence from the source paper that we did not copy at all. "
            + COPIED
            + " And a closing sentence from the source that is likewise not ours."
        ),
    }]

    matches = plagiarism_matcher.match_chunks(
        input_chunks=input_chunks,
        candidate_chunks=candidate_chunks,
        top_k=3,
        similarity_threshold=0.5,
    )

    verified = sentence_matcher.verify_all_matches(matches)

    report = build_final_report(
        verified_matches=verified,
        input_chunks=input_chunks,
        input_text=document["text"],
        document=document,
    )

    return document, report


def test_offsets_survive_the_whole_pipeline(monkeypatch):
    document, report = _run_pipeline(monkeypatch)

    assert report["matches"], "expected the copied sentence to be matched"

    located = [m for m in report["matches"] if "input_offset" in m]
    assert located, "no match carried an input_offset"

    for match in located:
        offset = match["input_offset"]
        span = report["input_text"][offset["start"]:offset["end"]]
        # The offset points at the exact sentence, character for character.
        assert span == match["input_sentence"]
        assert offset["end"] - offset["start"] == offset["length"]
        assert offset["section"] == "abstract"
        assert offset["block_id"] is not None
        assert offset["chunk_id"]


def test_the_copied_sentence_is_the_one_located(monkeypatch):
    document, report = _run_pipeline(monkeypatch)

    offsets = [m["input_offset"] for m in report["matches"] if "input_offset" in m]
    expected_start = document["text"].index(COPIED)

    assert any(o["start"] == expected_start for o in offsets), (
        "the located span should be the verbatim-copied sentence"
    )


def test_score_reflects_the_copied_share_of_the_document(monkeypatch):
    document, report = _run_pipeline(monkeypatch)

    total = len(document["text"])
    scoring = report["scoring"]

    assert scoring["method"] == "weighted_char_coverage"
    assert scoring["total_chars"] == total
    # Only the copied sentence is implicated, so coverage must be a small
    # but non-zero share of the whole document — never 100%.
    assert 0 < scoring["covered_chars"] <= len(COPIED) + 2
    assert 0 < report["overall_score"] < 100
    assert report["overall_score"] <= round(len(COPIED) / total * 100, 2) + 0.01
