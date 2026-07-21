"""
Tests for the offset chain that makes precise match localization work:

    document_model.build_document
      -> extractor.build_chunks_from_sections (doc_start_char)
        -> document_model.split_sentences_with_spans (sentence spans)
          -> final_report_builder (absolute input_offset)

The invariant under test throughout: for every offset the backend emits,
`report["input_text"][start:end]` is the exact span being talked about.
"""

import re

from document_model import (
    build_document,
    block_at_offset,
    section_at_offset,
    split_sentences_with_spans,
    weighted_coverage,
)
from extractor import build_chunks_from_sections
from final_report_builder import build_final_report


SECTIONS = {
    "title": "A Study of Something Interesting",
    "abstract": (
        "This paper presents a study of something interesting. "
        "We evaluate our approach on three benchmark datasets and report "
        "consistent improvements over prior work in every configuration."
    ),
    "introduction": (
        "Understanding this phenomenon has been a long standing goal of the field. "
        "Prior approaches relied on handcrafted features that generalize poorly. "
        "We instead learn representations directly from data, which removes the "
        "need for manual engineering and improves robustness considerably."
    ),
    "conclusion": (
        "We presented a method for studying something interesting and showed "
        "that it outperforms prior work across the benchmarks we considered."
    ),
}


def test_document_text_contains_every_section_including_conclusion():
    document = build_document(SECTIONS)

    for name, content in SECTIONS.items():
        assert content in document["text"], f"{name} missing from canonical text"

    # The old manual join in main.py dropped `conclusion` even though
    # conclusion chunks were fed to the matcher.
    assert "conclusion" in document["section_offsets"]


def test_section_offsets_address_the_canonical_text():
    document = build_document(SECTIONS)
    text = document["text"]

    for entry in document["sections"]:
        assert text[entry["start"]:entry["end"]] == SECTIONS[entry["section"]].strip()


def test_blocks_cover_their_sections_and_are_addressable():
    document = build_document(SECTIONS)
    text = document["text"]

    assert document["blocks"], "expected at least one block"

    for block in document["blocks"]:
        span = text[block["start"]:block["end"]]
        assert span.strip() == span
        assert span
        assert block_at_offset(document, block["start"]) == block["block_id"]
        assert section_at_offset(document, block["start"]) == block["section"]


def test_chunk_doc_offsets_resolve_to_the_chunk_text():
    document = build_document(SECTIONS)
    text = document["text"]

    chunks = build_chunks_from_sections(
        SECTIONS,
        paper_id="input_paper",
        chunk_size=120,
        overlap=30,
        section_offsets=document["section_offsets"],
    )

    assert chunks

    for chunk in chunks:
        assert text[chunk["doc_start_char"]:chunk["doc_end_char"]] == chunk["text"]


def test_chunks_without_section_offsets_stay_backwards_compatible():
    chunks = build_chunks_from_sections(SECTIONS, chunk_size=120, overlap=30)

    assert chunks
    for chunk in chunks:
        assert "doc_start_char" not in chunk
        assert {"paper_id", "section", "chunk_id", "start_char", "end_char", "text"} <= set(chunk)


def test_sentence_spans_resolve_exactly():
    raw = (
        "  The first sentence is long enough to survive the length filter.\n"
        "The second sentence is also comfortably long enough to be kept.  "
    )

    sentences = split_sentences_with_spans(raw)

    assert len(sentences) == 2
    for item in sentences:
        # Span points at the untouched source text...
        assert raw[item["start"]:item["end"]] == item["text"]
        # ...and the returned text is whitespace-normalized.
        assert "  " not in item["text"]


def test_sentence_spans_survive_collapsed_whitespace():
    raw = "A sentence with\n  awkward   internal spacing that is still long.  Another sentence that is also long enough here."

    sentences = split_sentences_with_spans(raw)

    assert len(sentences) == 2
    for item in sentences:
        span = raw[item["start"]:item["end"]]
        assert re.sub(r"\s+", " ", span) == item["text"]


def test_sentence_splitting_matches_the_legacy_behaviour():
    """The old implementation collapsed whitespace first. Boundaries and
    the resulting sentence strings must be unchanged."""

    def legacy_split(text):
        text = re.sub(r"\s+", " ", text.strip())
        parts = re.split(r"(?<=[.!?])\s+|(?<=\))\s+(?=[A-Z])", text)
        return [p.strip() for p in parts if len(p.strip()) >= 40]

    for source in [
        SECTIONS["abstract"],
        SECTIONS["introduction"],
        "Short one. A sentence that is definitely long enough to be retained here.",
        "Ends with a parenthetical (as papers often do) Then a new sentence long enough.",
        "",
    ]:
        assert [s["text"] for s in split_sentences_with_spans(source)] == legacy_split(source)


# =========================
# Percentage recalculation
# =========================

def test_weighted_coverage_counts_each_character_once():
    # Two overlapping intervals of the same weight over [0, 150).
    result = weighted_coverage([(0, 100, 1.0), (50, 150, 1.0)], total_chars=300)

    assert result["covered_chars"] == 150
    assert result["matched_chars"] == 150.0
    assert result["score"] == 50.0


def test_weighted_coverage_takes_the_highest_weight_per_character():
    # A "suspicious" span (0.5) fully inside a "likely" span (1.0).
    result = weighted_coverage([(0, 100, 1.0), (25, 75, 0.5)], total_chars=100)

    assert result["covered_chars"] == 100
    assert result["matched_chars"] == 100.0
    assert result["score"] == 100.0


def test_weighted_coverage_handles_abutting_intervals():
    result = weighted_coverage([(0, 50, 1.0), (50, 100, 1.0)], total_chars=100)

    assert result["covered_chars"] == 100
    assert result["score"] == 100.0


def test_weighted_coverage_is_bounded_and_empty_safe():
    assert weighted_coverage([], total_chars=100)["score"] == 0.0
    assert weighted_coverage([(0, 10, 1.0)], total_chars=0)["score"] == 0.0
    assert weighted_coverage([(0, 500, 1.0)], total_chars=100)["score"] == 100.0


def _verified_match(doc_start, doc_end, sentence, label="likely_plagiarism", source="paper_a"):
    return {
        "input_chunk_id": f"chunk_{doc_start}",
        "input_section": "abstract",
        "source_paper_id": source,
        "source_title": "Some Source Paper",
        "source_chunk_id": "src_0",
        "source_section": "abstract",
        "chunk_semantic_similarity": 0.95,
        "chunk_word_overlap": 0.5,
        "chunk_char_ngram_overlap": 0.5,
        "chunk_label": label,
        "sentence_matches": [{
            "input_sentence_index": 0,
            "source_sentence_index": 0,
            "input_sentence": sentence,
            "source_sentence": sentence,
            "semantic_similarity": 0.95,
            "word_overlap": 0.9,
            "char_ngram_overlap": 0.9,
            "label": label,
            "input_chunk_start": 0,
            "input_chunk_end": len(sentence),
            "source_chunk_start": 0,
            "source_chunk_end": len(sentence),
            "input_doc_start": doc_start,
            "input_doc_end": doc_end,
        }],
    }


def test_report_emits_absolute_offsets_that_resolve_in_input_text():
    document = build_document(SECTIONS)
    text = document["text"]

    start = text.index("We evaluate")
    end = start + len("We evaluate our approach on three benchmark datasets and report")
    sentence = text[start:end]

    report = build_final_report(
        verified_matches=[_verified_match(start, end, sentence)],
        input_chunks=[{"text": text}],
        input_text=text,
        document=document,
    )

    match = report["matches"][0]
    offset = match["input_offset"]

    assert report["input_text"][offset["start"]:offset["end"]] == sentence
    assert offset["length"] == end - start
    assert offset["section"] == "abstract"
    assert offset["block_id"] is not None


def test_same_span_matched_by_two_papers_is_not_double_counted():
    document = build_document(SECTIONS)
    text = document["text"]

    start = text.index("We evaluate")
    end = start + 60
    sentence = text[start:end]

    report = build_final_report(
        verified_matches=[
            _verified_match(start, end, sentence, source="paper_a"),
            _verified_match(start, end, sentence, source="paper_b"),
        ],
        input_chunks=[{"text": text}],
        input_text=text,
        document=document,
    )

    # Both matches are still reported (two different sources)...
    assert len(report["matches"]) == 2
    # ...but the span counts once towards the score.
    assert report["scoring"]["covered_chars"] == end - start
    expected = round((end - start) / len(text) * 100, 2)
    assert report["overall_score"] == expected


def test_scoring_block_reports_both_formulas():
    document = build_document(SECTIONS)
    text = document["text"]
    start = text.index("We evaluate")
    end = start + 60

    report = build_final_report(
        verified_matches=[_verified_match(start, end, text[start:end])],
        input_chunks=[{"text": text}],
        input_text=text,
        document=document,
    )

    scoring = report["scoring"]
    assert scoring["method"] == "weighted_char_coverage"
    assert scoring["total_chars"] == len(text)
    assert "legacy_overall_score" in scoring
    assert report["document"]["text_field"] == "input_text"


def test_report_without_offsets_falls_back_to_the_legacy_score():
    """A caller that hasn't been migrated must not silently report 0%."""
    sentence = "A matched sentence long enough to be considered by the pipeline."
    match = _verified_match(0, len(sentence), sentence)
    for sm in match["sentence_matches"]:
        sm.pop("input_doc_start")
        sm.pop("input_doc_end")

    report = build_final_report(
        verified_matches=[match],
        input_chunks=[{"text": sentence * 2}],
        input_text=sentence * 2,
    )

    assert report["scoring"]["method"] == "legacy_weighted_sentence_sum"
    assert report["overall_score"] > 0
    assert "input_offset" not in report["matches"][0]
