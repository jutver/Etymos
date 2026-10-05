# -*- coding: utf-8 -*-
import pytest

from extractor import is_probable_title_or_author, section_from_heading


@pytest.mark.parametrize("heading, expected", [
    ("1 Introduction", "introduction"),
    ("1 Introduction and Motivation", "introduction"),
    ("2 Related Works", "related_work"),
    ("2. Research Context and Scope", "related_work"),
    ("3 Materials and Methods", "method"),
    ("3. System Model", "method"),
    ("5. Experimental Design", "experiment"),
    ("6. Results under Exact Forecasts", "experiment"),
    ("Conclusion and Future Works", "conclusion"),
    ("Tóm tắt", "abstract"),
    ("1. Giới thiệu", "introduction"),
    ("MỞ ĐẦU", "introduction"),
    ("Chương 2. Tổng quan", "related_work"),
    ("2. Phương pháp đề xuất", "method"),
    ("4. Kết quả thực nghiệm", "experiment"),
    ("Kết luận", "conclusion"),
    ("Tài liệu tham khảo", "references"),
    ("3 V I H ATE T5", None),
])
def test_section_from_heading(heading, expected):
    assert section_from_heading(heading) == expected


def test_large_numbered_heading_on_page_one_is_not_title():
    line = {"text": "1. Introduction", "page": 1, "size": 14.0, "words": 2}
    assert is_probable_title_or_author(line, body_size=11.0) is False


# --- Headings whose words name no section: placed by position / style ---

import fitz  # noqa: E402

from extractor import (  # noqa: E402
    extract_structured_sections_from_pdf,
    flatten_structured_sections,
)

_BODY = (
    "This paragraph explains the work in detail and keeps going for a while "
    "so the part has enough body text to count as real content. "
) * 6


def _make_pdf(path, title, headings, heading_size=14, abstract=True):
    doc = fitz.open()
    page = doc.new_page()
    y = 60

    def write(text, size, bold):
        nonlocal page, y
        words = text.split()
        per_line = max(4, int(90 * 11 / size / 6))
        for k in range(0, len(words), per_line):
            if y > 780:
                page = doc.new_page()
                y = 60
            page.insert_text(
                (50, y), " ".join(words[k:k + per_line]),
                fontsize=size, fontname="hebo" if bold else "helv",
            )
            y += size + 4
        y += 6

    write(title, 22, True)
    if abstract:
        write("Abstract", heading_size, True)
        write(_BODY, 11, False)
    for heading in headings:
        write(heading, heading_size, True)
        write(_BODY, 11, False)
    write("References", heading_size, True)
    write("[1] A. Author. Some paper. 2020.", 11, False)
    doc.save(str(path))


def _sections(path):
    structured = extract_structured_sections_from_pdf(str(path))
    flat = flatten_structured_sections(structured)
    headings = {
        b["text"]: name
        for name, blocks in structured["sections"].items()
        for b in blocks
        if b["type"] == "heading"
    }
    return flat, headings


def test_numbered_headings_without_section_words(tmp_path):
    pdf = tmp_path / "numbered.pdf"
    _make_pdf(pdf, "Routing Packets Smarter", [
        "1. Why This Matters", "2. What Others Tried",
        "3. Building the Router", "4. Trying It Out", "5. Wrapping Up",
    ])
    flat, headings = _sections(pdf)

    assert headings["1. Why This Matters"] == "introduction"
    assert headings["5. Wrapping Up"] == "conclusion"
    assert headings["3. Building the Router"] in ("method", "experiment")
    for name in ("abstract", "introduction", "method", "experiment", "conclusion"):
        assert flat[name], name


def test_unnumbered_headings_found_by_style(tmp_path):
    pdf = tmp_path / "unnumbered.pdf"
    _make_pdf(pdf, "Notes on Gardening", [
        "Getting Started", "Choosing Plants", "Soil and Water",
        "Seasonal Care", "Final Thoughts",
    ], heading_size=13, abstract=False)
    flat, headings = _sections(pdf)

    assert headings["Getting Started"] == "introduction"
    assert headings["Final Thoughts"] == "conclusion"
    assert flat["introduction"] and flat["conclusion"]


def test_unnumbered_keyword_headings_next_to_abstract(tmp_path):
    pdf = tmp_path / "keywords.pdf"
    _make_pdf(pdf, "A Study of Things", [
        "Introduction", "Related Work", "Methodology", "Results", "Conclusion",
    ])
    flat, headings = _sections(pdf)

    assert headings["Introduction"] == "introduction"
    assert headings["Related Work"] == "related_work"
    assert headings["Methodology"] == "method"
    assert headings["Results"] == "experiment"
    assert headings["Conclusion"] == "conclusion"
