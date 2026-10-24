"""
Chunks start and end on sentence boundaries, and the report keeps one
match per source for a passage.

Fixed 900-char windows used to cut sentences (and words) in half; the
cut-off pieces were matched as sentences of their own, giving duplicate
cards and highlights that ended mid-word. The golden test runs on
TEST_Documents/1408.5882v2.pdf (not committed) and skips without it.
"""

from pathlib import Path

import pytest

from document_model import build_document, split_sentences_with_spans
from extractor import (
    build_chunks_from_sections,
    extract_structured_sections_from_pdf,
    flatten_structured_sections,
    sentence_windows,
)
from final_report_builder import drop_nested_duplicates

PAPER = Path(__file__).resolve().parents[2] / "TEST_Documents" / "1408.5882v2.pdf"


def _text(sentences=60):
    return " ".join(
        f"Sentence number {i} talks about convolutional networks and static vectors." for i in range(sentences)
    )


def _sentence_starts(text):
    return {0} | {s["start"] for s in split_sentences_with_spans(text, min_chars=0)}


def test_windows_start_and_end_on_sentences():
    text = _text()
    starts = _sentence_starts(text)
    windows = sentence_windows(text, chunk_size=900, overlap=150)

    assert windows[0][0] == 0 and windows[-1][1] == len(text)
    for start, end in windows:
        assert start in starts
        assert end == len(text) or text[:end].rstrip().endswith(".")
        assert end - start <= 900


def test_windows_overlap_by_whole_sentences_and_cover_the_text():
    text = _text()
    windows = sentence_windows(text, chunk_size=900, overlap=150)

    for (s1, e1), (s2, e2) in zip(windows, windows[1:]):
        assert s1 < s2 < e1 < e2
        assert e1 - s2 >= 70  # at least one of the ~75-char sentences


def test_a_sentence_longer_than_the_window_is_kept_whole_or_cut_at_a_space():
    long_sentence = ("word " * 250).strip() + "."  # 1250 chars
    windows = sentence_windows(long_sentence + " Short end here.", chunk_size=900, overlap=150)
    assert windows[0] == (0, len(long_sentence) + 1)

    giant = ("word " * 600).strip()  # over 2 * chunk_size: cut at a space
    windows = sentence_windows(giant, chunk_size=900, overlap=150)
    for start, end in windows:
        assert end == len(giant) or giant[end] == " "
    assert windows[-1][1] == len(giant)


def test_chunk_offsets_are_exact():
    sections = {"title": "T", "method": "  " + _text() + "  "}
    chunks = build_chunks_from_sections(sections, section_offsets={"method": 100})
    text = sections["method"].strip()

    assert len(chunks) > 1
    for chunk in chunks:
        assert text[chunk["start_char"]:chunk["end_char"]] == chunk["text"]
        assert chunk["doc_start_char"] == 100 + chunk["start_char"]


def _match(source, start, end, label="likely_plagiarism", similarity=0.9):
    return {
        "source_paper_id": source,
        "label": label,
        "semantic_similarity": similarity,
        "input_offset": {"start": start, "end": end},
    }


def test_nested_matches_from_one_source_keep_the_whole_sentence():
    full = _match("a", 100, 200)
    piece = _match("a", 150, 200, similarity=0.95)
    other_source = _match("b", 150, 200)
    elsewhere = _match("a", 300, 400)

    kept = drop_nested_duplicates([piece, full, other_source, elsewhere])

    assert kept == [full, other_source, elsewhere]


def test_a_stronger_label_beats_a_longer_span():
    strong = _match("a", 120, 180, label="likely_plagiarism", similarity=0.8)
    weak = _match("a", 100, 200, label="suspicious", similarity=0.99)
    assert drop_nested_duplicates([weak, strong]) == [strong]


def test_partly_overlapping_and_offsetless_matches_are_kept():
    first = _match("a", 100, 200)
    second = _match("a", 150, 250)
    legacy = {"source_title": "Old", "label": "likely_plagiarism"}
    assert drop_nested_duplicates([first, second, legacy]) == [first, second, legacy]


@pytest.mark.skipif(not PAPER.exists(), reason="TEST_Documents/1408.5882v2.pdf not present")
def test_real_paper_sentences_never_start_or_end_mid_word():
    structured = extract_structured_sections_from_pdf(str(PAPER))
    sections = flatten_structured_sections(structured)
    document = build_document(sections, structured_sections=structured["sections"])
    text = document["text"]
    chunks = build_chunks_from_sections(sections, section_offsets=document["section_offsets"])
    assert chunks

    spans = set()
    for chunk in chunks:
        assert text[chunk["doc_start_char"]:chunk["doc_end_char"]] == chunk["text"]
        for sentence in split_sentences_with_spans(chunk["text"]):
            start = chunk["doc_start_char"] + sentence["start"]
            end = chunk["doc_start_char"] + sentence["end"]
            assert start == 0 or not text[start - 1].isalnum(), text[max(0, start - 20):end]
            assert end == len(text) or not text[end].isalnum(), text[start:end + 20]
            spans.add((start, end))

    # The same sentence seen through two overlapping chunks has the same
    # span; no sentence is a cut-off piece of another.
    ordered = sorted(spans)
    for (s1, e1), (s2, e2) in zip(ordered, ordered[1:]):
        assert e1 <= s2, (text[s1:e1], text[s2:e2])
