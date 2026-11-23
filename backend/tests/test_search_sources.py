"""Tests for academic vs web source classification and deduplication."""

from search_paper.paper_identity import (
    classify_source_kind,
    extract_arxiv_id,
    extract_doi,
    is_academic_url,
    strip_preprint_prefix,
)
from search_paper.search_sources import deduplicate_papers


def test_strip_preprint_prefix_and_extract_arxiv_id():
    assert strip_preprint_prefix("[2405.14141] ViHateT5: Enhancing Hate Speech Detection") == (
        "ViHateT5: Enhancing Hate Speech Detection"
    )
    assert strip_preprint_prefix("arXiv:2405.14141v2 - ViHateT5: Enhancing Hate Speech Detection") == (
        "ViHateT5: Enhancing Hate Speech Detection"
    )
    assert extract_arxiv_id("https://arxiv.org/abs/2405.14141v1") == "2405.14141"
    assert extract_arxiv_id("https://arxiv.org/pdf/2405.14141.pdf") == "2405.14141"
    assert extract_arxiv_id("[2405.14141] ViHateT5") == "2405.14141"
    assert extract_doi("https://doi.org/10.48550/arXiv.2405.14141") == "10.48550/arxiv.2405.14141"


def test_classify_source_kind_for_academic_repositories_and_general_web():
    assert is_academic_url("https://arxiv.org/abs/2405.14141") is True
    assert is_academic_url("https://aclanthology.org/2024.acl-long.10/") is True
    assert is_academic_url("https://ieeexplore.ieee.org/document/10123456") is True
    assert is_academic_url("https://example.com/blog/hate-speech") is False

    assert classify_source_kind({
        "title": "[2405.14141] ViHateT5: Enhancing Hate Speech Detection",
        "url": "https://arxiv.org/abs/2405.14141",
        "source_kind": "web",
    }) == "academic"

    assert classify_source_kind({
        "title": "Hate speech overview blog post",
        "url": "https://medium.com/@author/hate-speech-overview",
        "source_kind": "web",
    }) == "web"


def test_deduplicate_papers_unifies_academic_and_arxiv_web_hits_with_academic_precedence():
    web_first = {
        "title": "[2405.14141] ViHateT5: Enhancing Hate Speech Detection in Vietnamese",
        "url": "https://arxiv.org/abs/2405.14141",
        "source_kind": "web",
        "abstract": "However, these efforts remain fragmented.",
    }
    academic_second = {
        "title": "ViHateT5: Enhancing Hate Speech Detection in Vietnamese",
        "url": "https://www.semanticscholar.org/paper/abc123",
        "pdf_url": "https://arxiv.org/pdf/2405.14141.pdf",
        "source_kind": "academic",
        "authors": ["Luan Thanh Nguyen"],
        "year": "2024",
        "doi": "10.48550/arXiv.2405.14141",
    }

    unified = deduplicate_papers([web_first, academic_second])
    assert len(unified) == 1
    paper = unified[0]
    assert paper["source_kind"] == "academic"
    assert paper["title"] == "ViHateT5: Enhancing Hate Speech Detection in Vietnamese"
    assert paper["authors"] == ["Luan Thanh Nguyen"]
    assert paper["year"] == "2024"
    assert paper["doi"] == "10.48550/arXiv.2405.14141"
    assert paper["pdf_url"] == "https://arxiv.org/pdf/2405.14141.pdf"


def test_deduplicate_papers_keeps_distinct_web_source_as_web():
    academic = {
        "title": "ViHateT5: Enhancing Hate Speech Detection in Vietnamese",
        "url": "https://arxiv.org/abs/2405.14141",
        "source_kind": "academic",
    }
    blog = {
        "title": "Understanding Vietnamese NLP datasets in production",
        "url": "https://towardsdatascience.com/vietnamese-nlp-datasets",
        "source_kind": "web",
    }
    unified = deduplicate_papers([academic, blog])
    assert len(unified) == 2
    assert unified[0]["source_kind"] == "academic"
    assert unified[1]["source_kind"] == "web"
