"""Tests for cross-source match unification and published paper self-match detection."""

from final_report_builder import build_final_report


def _verified_item(
    *,
    source_id,
    source_title,
    chunk_id,
    sentence,
    start,
    end,
    similarity=0.98,
):
    return {
        "input_chunk_id": chunk_id,
        "input_section": "introduction",
        "source_paper_id": source_id,
        "source_title": source_title,
        "source_section": "introduction",
        "source_chunk_id": f"{source_id}_c1",
        "sentence_matches": [
            {
                "input_sentence_index": 0,
                "source_sentence_index": 0,
                "input_sentence": sentence,
                "source_sentence": sentence,
                "semantic_similarity": similarity,
                "word_overlap": 1.0,
                "char_ngram_overlap": 1.0,
                "label": "likely_plagiarism",
                "input_doc_start": start,
                "input_doc_end": end,
            }
        ],
    }


def test_build_final_report_unifies_web_and_academic_hits_for_same_paper_and_span():
    sentence = (
        "However, these efforts remain fragmented due to the reliance on "
        "separate fine-tuned models for distinct tasks."
    )
    input_text = sentence
    document = {
        "version": 1,
        "text": input_text,
        "total_chars": len(input_text),
        "sections": [{"section": "introduction", "start": 0, "end": len(input_text)}],
        "blocks": [{"block_id": "b0", "type": "paragraph", "text": input_text, "start": 0, "end": len(input_text)}],
    }
    verified = [
        _verified_item(
            source_id="ddg_123",
            source_title="[2405.14141] ViHateT5: Enhancing Hate Speech Detection",
            chunk_id="c0",
            sentence=sentence,
            start=0,
            end=len(sentence),
            similarity=0.9824,
        ),
        _verified_item(
            source_id="s2_456",
            source_title="ViHateT5: Enhancing Hate Speech Detection",
            chunk_id="c0",
            sentence=sentence,
            start=0,
            end=len(sentence),
            similarity=0.9824,
        ),
    ]
    source_metadata = {
        "ddg_123": {
            "source_url": "https://arxiv.org/abs/2405.14141",
            "source_pdf_url": "",
            "source_kind": "web",
            "source_authors": [],
            "source_year": "",
            "source_doi": "",
        },
        "s2_456": {
            "source_url": "",
            "source_pdf_url": "https://arxiv.org/pdf/2405.14141.pdf",
            "source_kind": "academic",
            "source_authors": ["Luan Thanh Nguyen"],
            "source_year": "2024",
            "source_doi": "10.48550/arXiv.2405.14141",
        },
    }

    report = build_final_report(
        verified,
        input_chunks=[{"chunk_id": "c0", "text": input_text}],
        input_text=input_text,
        document=document,
        source_metadata=source_metadata,
    )

    assert len(report["matches"]) == 1
    match = report["matches"][0]
    assert match["source_kind"] == "academic"
    assert match["source_title"] == "ViHateT5: Enhancing Hate Speech Detection"
    assert match["source_authors"] == ["Luan Thanh Nguyen"]
    assert match["source_year"] == "2024"
    assert match["source_doi"] == "10.48550/arXiv.2405.14141"
    assert match["source_url"] == "https://arxiv.org/abs/2405.14141"
    assert len(report["matched_papers"]) == 1


def test_detects_published_paper_self_match_for_full_paper():
    s1 = "ViHateT5: Enhancing Hate Speech Detection in Vietnamese."
    s2 = "Hate speech detection on social media remains a challenging NLP problem across languages."
    s3 = "We introduce a unified text-to-text transformer model trained on multi-task benchmarks."
    s4 = "Experimental results demonstrate state-of-the-art accuracy across three public datasets."
    input_text = f"{s1}\n{s2} {s3} {s4}"
    document = {
        "version": 1,
        "text": input_text,
        "total_chars": len(input_text),
        "sections": [
            {"section": "title", "start": 0, "end": len(s1), "text": s1},
            {"section": "introduction", "start": len(s1) + 1, "end": len(input_text)},
        ],
        "blocks": [],
    }
    verified = [
        _verified_item(
            source_id="s2_456",
            source_title="ViHateT5: Enhancing Hate Speech Detection in Vietnamese",
            chunk_id="c1",
            sentence=s2,
            start=input_text.index(s2),
            end=input_text.index(s2) + len(s2),
        ),
        _verified_item(
            source_id="s2_456",
            source_title="ViHateT5: Enhancing Hate Speech Detection in Vietnamese",
            chunk_id="c2",
            sentence=s3,
            start=input_text.index(s3),
            end=input_text.index(s3) + len(s3),
        ),
        _verified_item(
            source_id="s2_456",
            source_title="ViHateT5: Enhancing Hate Speech Detection in Vietnamese",
            chunk_id="c3",
            sentence=s4,
            start=input_text.index(s4),
            end=input_text.index(s4) + len(s4),
        ),
    ]
    source_metadata = {
        "s2_456": {
            "source_url": "https://arxiv.org/abs/2405.14141",
            "source_kind": "academic",
            "source_authors": ["Luan Thanh Nguyen"],
            "source_year": "2024",
            "source_doi": "10.48550/arXiv.2405.14141",
        }
    }

    report = build_final_report(
        verified,
        input_chunks=[{"chunk_id": "c1", "text": input_text}],
        input_text=input_text,
        document=document,
        source_metadata=source_metadata,
    )

    ppm = report.get("published_paper_match")
    assert ppm is not None
    assert ppm["detected"] is True
    assert ppm["source_title"] == "ViHateT5: Enhancing Hate Speech Detection in Vietnamese"
    assert ppm["title_matched"] is True
    assert ppm["coverage_percent"] >= 70.0
    assert ppm["source_url"] == "https://arxiv.org/abs/2405.14141"


def test_does_not_trigger_published_paper_match_on_low_overlap_draft():
    quoted = "Hate speech detection on social media remains challenging."
    original = " ".join(["This is our independent original analysis of regional dialects."] * 12)
    input_text = f"My Original Survey Paper\n{quoted} {original}"
    document = {
        "version": 1,
        "text": input_text,
        "total_chars": len(input_text),
        "sections": [{"section": "title", "start": 0, "end": 23, "text": "My Original Survey Paper"}],
        "blocks": [],
    }
    verified = [
        _verified_item(
            source_id="s2_456",
            source_title="ViHateT5: Enhancing Hate Speech Detection in Vietnamese",
            chunk_id="c1",
            sentence=quoted,
            start=input_text.index(quoted),
            end=input_text.index(quoted) + len(quoted),
        )
    ]
    source_metadata = {
        "s2_456": {
            "source_url": "https://arxiv.org/abs/2405.14141",
            "source_kind": "academic",
            "source_authors": ["Luan Thanh Nguyen"],
            "source_year": "2024",
        }
    }

    report = build_final_report(
        verified,
        input_chunks=[{"chunk_id": "c1", "text": input_text}],
        input_text=input_text,
        document=document,
        source_metadata=source_metadata,
    )

    assert "published_paper_match" not in report


def test_sort_matches_orders_canonically_top_to_bottom():
    from final_report_builder import sort_matches

    late = {
        "label": "likely_plagiarism",
        "semantic_similarity": 0.99,
        "input_offset": {"start": 320, "end": 400},
    }
    early = {
        "label": "suspicious",
        "semantic_similarity": 0.81,
        "input_offset": {"start": 20, "end": 90},
    }
    pdf_only_p1 = {
        "label": "likely_plagiarism",
        "semantic_similarity": 0.95,
        "pdf_rects": [{"page": 1, "x0": 40.0, "y0": 150.0, "x1": 200.0, "y1": 170.0}],
    }
    pdf_only_p2 = {
        "label": "likely_plagiarism",
        "semantic_similarity": 0.99,
        "pdf_rects": [{"page": 2, "x0": 40.0, "y0": 80.0, "x1": 200.0, "y1": 100.0}],
    }
    unlocated_low = {"label": "suspicious", "semantic_similarity": 0.72}
    unlocated_high = {"label": "likely_plagiarism", "semantic_similarity": 0.92}

    ordered = sort_matches([unlocated_low, late, pdf_only_p2, early, unlocated_high, pdf_only_p1])
    assert ordered == [early, late, pdf_only_p1, pdf_only_p2, unlocated_high, unlocated_low]
