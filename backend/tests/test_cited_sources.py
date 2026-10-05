"""Tests for cited_sources: matches against sources listed in the document's
own reference list are dropped; uncited sources keep the normal flow."""

from cited_sources import (
    ReferenceIndex,
    extract_reference_text,
    filter_cited_matches,
    is_source_cited,
)
from document_model import build_document


BODY = (
    "Hate speech detection on social media has been widely studied.\n\n"
    "Transformer models improve the results on Vietnamese benchmarks."
)

REFERENCES = (
    "[1] Nguyen, A. (2021). ViHOS: Hate speech spans detec- tion for Vietnamese. ACL.\n\n"
    "[2] Vaswani, A. et al. (2017). Attention Is All You Need. NeurIPS. doi:10.5555/3295222.3295349"
)


def _item(source_id, title, sentences=1):
    return {
        "source_paper_id": source_id,
        "source_title": title,
        "sentence_matches": [{"label": "suspicious"} for _ in range(sentences)],
    }


def _pdf_like_document():
    # PDF path: the "References" heading is a zero-length section-heading
    # block that is NOT part of the document text.
    sections = {"body": BODY, "back_matter": REFERENCES}
    structured = {
        "back_matter": [
            {"type": "heading", "level": 2, "text": "References", "section_heading": True},
            *({"type": "paragraph", "text": part} for part in REFERENCES.split("\n\n")),
        ],
    }
    return build_document(sections, structured_sections=structured, section_order=["body", "back_matter"])


def _docx_like_document():
    # .docx / pasted path: the heading is an ordinary line of the text.
    return build_document({"body": BODY + "\n\nReferences\n\n" + REFERENCES})


def test_extracts_reference_list_from_pdf_section_heading_block():
    document = _pdf_like_document()
    refs = extract_reference_text(document, document["text"])
    assert "ViHOS" in refs and "Attention Is All You Need" in refs
    assert "widely studied" not in refs


def test_extracts_reference_list_from_plain_heading_line():
    document = _docx_like_document()
    refs = extract_reference_text(document, document["text"])
    assert "ViHOS" in refs
    assert "widely studied" not in refs


def test_reference_list_stops_at_appendix():
    text = BODY + "\n\nReferences\n\n" + REFERENCES
    document = build_document(
        {"body": text, "back_matter": "Extra tables about Graph Neural Networks for Everything."},
        structured_sections={"back_matter": [
            {"type": "heading", "level": 2, "text": "Appendix A", "section_heading": True},
            {"type": "paragraph", "text": "Extra tables about Graph Neural Networks for Everything."},
        ]},
        section_order=["body", "back_matter"],
    )
    refs = extract_reference_text(document, document["text"])
    assert "ViHOS" in refs
    assert "Graph Neural Networks" not in refs


def test_no_reference_list_means_nothing_is_excluded():
    document = build_document({"body": BODY})
    items = [_item("p1", "Attention Is All You Need")]
    result = filter_cited_matches(items, document=document, input_text=document["text"])
    assert result["kept"] == items
    assert result["cited_sources"] == []
    assert result["reference_found"] is False


def test_title_match_survives_case_punctuation_and_pdf_hyphenation():
    index = ReferenceIndex(REFERENCES)
    assert is_source_cited(index, title="ViHOS: Hate Speech Spans Detection for Vietnamese")
    assert is_source_cited(index, title="attention is all you need")


def test_fuzzy_title_match_tolerates_one_mangled_word():
    index = ReferenceIndex("[3] Le, B. (2020). A large scale dataset for Vietnamese hate speech detectoin. LREC.")
    assert is_source_cited(index, title="A Large-Scale Dataset for Vietnamese Hate Speech Detection")


def test_doi_match():
    index = ReferenceIndex(REFERENCES)
    assert is_source_cited(index, title="Some other title", doi="https://doi.org/10.5555/3295222.3295349")


def test_unrelated_or_too_short_titles_are_not_cited():
    index = ReferenceIndex(REFERENCES)
    assert not is_source_cited(index, title="Graph Neural Networks for Molecular Property Prediction")
    # Two common words that happen to appear in the list are not a title match.
    assert not is_source_cited(index, title="Speech Recognition")


def test_filter_drops_only_cited_sources():
    document = _pdf_like_document()
    cited = _item("p_cited", "Attention Is All You Need", sentences=3)
    uncited = _item("p_new", "Graph Neural Networks for Molecular Property Prediction")
    by_doi = _item("p_doi", "Title the search API spelled differently", sentences=2)

    result = filter_cited_matches(
        [cited, uncited, by_doi],
        document=document,
        input_text=document["text"],
        source_metadata={"p_doi": {"source_doi": "10.5555/3295222.3295349"}},
    )

    assert result["kept"] == [uncited]
    assert result["reference_found"] is True
    assert {c["source_paper_id"]: c["excluded_sentence_matches"] for c in result["cited_sources"]} == {
        "p_cited": 3,
        "p_doi": 2,
    }
