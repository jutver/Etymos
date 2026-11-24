"""Tests for shared backend/source_title.py source title cleaning."""

from source_title import sanitize_source_title


def test_cleans_concatenated_multi_mirror_academic_title():
    dirty = (
        "(PDF) ViHateT5: Enhancing Hate Speech Detection in ...ViHateT5: Enhancing Hate Speech "
        "Detection in Vietnamese With ...(PDF) ViHateT5: Enhancing Hate Speech Detection in "
        "Vietnamese ...VIH T5: Enhancing Hate Speech Detection in Vietnamese With a "
        "...tarudesu/ViHateT5-base-HSD · Hugging FaceViHateT5 - Vietnamese Hate Speech Detection with T5"
    )
    cleaned = sanitize_source_title(dirty, is_academic=True)
    assert "Hugging Face" not in cleaned
    assert "(PDF)" not in cleaned
    assert cleaned.startswith("ViHateT5: Enhancing Hate Speech Detection in Vietnamese")
    assert len(cleaned) <= 160


def test_strips_arxiv_preprint_prefix_for_academic_sources():
    assert sanitize_source_title("[2405.14141] ViHateT5: Enhancing Hate Speech", is_academic=True) == (
        "ViHateT5: Enhancing Hate Speech"
    )


def test_strips_glued_prefix_repetition_without_ellipsis():
    title = "Neural Machine Translation in Low Resource Settings"
    glued = f"{title}{title}"
    assert sanitize_source_title(glued, is_academic=True) == title


def test_truncates_overlong_titles_at_word_boundary():
    long_title = (
        "A Very Long Empirical Comparative Investigation Across Multiple Low Resource "
        "Southeast Asian Language Benchmarks and Pretrained Transformer Architectures "
        "Evaluated Under Adversarial Conditions"
    )
    cleaned = sanitize_source_title(long_title, max_length=100)
    assert len(cleaned) <= 100
    assert cleaned.endswith("…")
