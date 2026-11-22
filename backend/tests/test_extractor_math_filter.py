"""
Regression tests for extractor.is_heavy_math_line.

The filter exists to keep equations and table rows out of the extracted body
text. It used to count the ASCII hyphen as a math symbol, so any prose line
holding three hyphens ("text-to-text", "state-of-the-art", or a line-end break
like "architec-") was judged an equation and dropped whole — leaving sentences
with a hole in the middle ("By ture, ..." for "By harnessing the power of a
text-to-text architecture, ...").
"""

import pytest

from extractor import is_heavy_math_line

# Real lines from the ViHateT5 abstract (arXiv 2405.14141) that were dropped.
PROSE_LINES_WITH_HYPHENS = [
    "gence of transformer-based pre-trained lan-",
    "fine-tuning general pre-trained models, pri-",
    "harnessing the power of a text-to-text architec-",
    "a unified model and obtain state-of-the-art per-",
    "2023 ). However, current state-of-the-art models",
    "sue of fragmentation, a unified text-to-text-based",
]


@pytest.mark.parametrize("line", PROSE_LINES_WITH_HYPHENS)
def test_hyphenated_prose_is_kept(line):
    assert is_heavy_math_line(line) is False


def test_citation_tail_split_across_lines_is_kept():
    assert is_heavy_math_line("et al. , 2022 ).") is False


@pytest.mark.parametrize(
    "line",
    [
        "(1)",
        "(12a)",
        "y = w x + b + c",  # three operators
        "z = x − y + w × v",  # Unicode minus counts as math
        "a = b - c - d + e",  # spaced minus signs are still operators
        "0.45 0.32 0.11 0.90 0.80",  # table row of numbers
        "1",  # bare page number
        "-",  # stray bullet / separator, no letters
        "( )",
        "arXiv:2405.14141v2  [cs.CL]  4 Jun 2024",  # margin stamp
    ],
)
def test_real_math_and_noise_still_dropped(line):
    assert is_heavy_math_line(line) is True


def test_blank_line_is_dropped():
    assert is_heavy_math_line("   ") is True


def test_hyphenated_prose_survives_alongside_extracted_display_formula(tmp_path, monkeypatch):
    import fitz
    import extractor
    import pdf_formula

    monkeypatch.setattr(pdf_formula, "get_latex_ocr_engine", lambda: None)
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 72), "1 Abstract", fontsize=14, fontname="hebo")
    page.insert_text((72, 102), "By harnessing the power of a text-to-text architec-", fontsize=10.5, fontname="helv")
    page.insert_text((72, 118), "ture, state-of-the-art models show clear gains.", fontsize=10.5, fontname="helv")
    page.insert_htmlbox(fitz.Rect(180, 140, 420, 164), '<p style="font-size:11pt;margin:0">z = x − y + w × v</p>')
    page.insert_text((500, 154), "(1)", fontsize=10.5, fontname="helv")
    pdf = tmp_path / "hyphen_and_math.pdf"
    doc.save(str(pdf))

    structured = extractor.extract_structured_sections_from_pdf(str(pdf), media=True)
    flat = extractor.flatten_structured_sections(structured)
    joined = " ".join(flat.values())
    assert "text-to-text" in joined
    assert "state-of-the-art" in joined
    assert "−" not in joined
    blocks = [b for sec in structured["sections"].values() for b in sec]
    assert any(b["type"] == "formula" for b in blocks)
