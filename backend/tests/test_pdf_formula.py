"""Tests for CPU mathematical formula extraction, validation, and fallback (T039)."""

from __future__ import annotations

import sys
from types import SimpleNamespace

import fitz
import pytest

import document_model
import extractor
import pdf_formula
import pdf_layout


def _make_stem_pdf(path):
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 72), "1 Introduction", fontsize=14, fontname="hebo")
    page.insert_htmlbox(
        fitz.Rect(72, 92, 520, 128),
        '<p style="font-size:10.5pt;margin:0">Our optimization objective combines cross-entropy with α ∈ ℝ and y = wx + b regularization.</p>',
    )
    # Display formula + right-aligned equation number (1)
    page.insert_htmlbox(
        fitz.Rect(180, 134, 420, 162),
        '<p style="font-size:11pt;margin:0">L = ∑ y + ∇θ − λ</p>',
    )
    page.insert_text((500, 148), "(1)", fontsize=10.5, fontname="helv")
    page.insert_text(
        (72, 184),
        "By harnessing the power of a text-to-text architecture, state-of-the-art accuracy improves.",
        fontsize=10.5,
        fontname="helv",
    )
    doc.save(str(path))
    return path


def test_validate_latex_rejects_broken_and_unsafe_inputs():
    assert pdf_formula.validate_latex(r"\frac{a + b}{c}") is True
    assert pdf_formula.validate_latex(r"\begin{aligned}x &= 1\end{aligned}") is True

    assert pdf_formula.validate_latex("") is False
    assert pdf_formula.validate_latex(r"\frac{a}{b") is False
    assert pdf_formula.validate_latex(r"a} + {b") is False
    assert pdf_formula.validate_latex(r"\begin{aligned}x=1\end{cases}") is False
    assert pdf_formula.validate_latex("<script>alert(1)</script>") is False
    assert pdf_formula.validate_latex(r"\href{javascript:alert(1)}{x}") is False
    assert pdf_formula.validate_latex("bad \ue001 glyph") is False


def test_display_formula_and_inline_formulas_keep_input_text_clean(tmp_path, monkeypatch):
    pdf = _make_stem_pdf(tmp_path / "stem.pdf")
    monkeypatch.setattr(pdf_formula, "get_latex_ocr_engine", lambda: None)

    structured = extractor.extract_structured_sections_from_pdf(str(pdf), media=True)
    sections = extractor.flatten_structured_sections(structured)
    doc_model = document_model.build_document(
        sections,
        structured_sections=structured["sections"],
        section_order=structured["section_order"],
        extraction_meta=structured["extraction_meta"],
    )

    blocks = doc_model["blocks"]
    formula_blocks = [b for b in blocks if b["type"] == "formula"]
    assert len(formula_blocks) == 1
    fb = formula_blocks[0]
    assert fb["equation_number"] == "(1)"
    assert fb["start"] == fb["end"]  # Zero-length span never enters input_text
    assert fb.get("formula_latex")
    assert "(1)" not in doc_model["text"]
    assert "text-to-text" in doc_model["text"]
    assert "state-of-the-art" in doc_model["text"]
    assert structured["extraction_meta"]["formula_count"] >= 1

    # Inline formula annotation stays anchored cleanly inside the prose block.
    intro_texts = [b for b in blocks if b["type"] == "paragraph" and "regularization" in doc_model["text"][b["start"]:b["end"]]]
    assert len(intro_texts) == 1
    inline = intro_texts[0].get("inline_formulas") or []
    assert inline
    slice_text = doc_model["text"][intro_texts[0]["start"]:intro_texts[0]["end"]]
    for item in inline:
        assert 0 <= item["start"] < item["end"] <= len(slice_text)


def test_rapid_latex_ocr_success_and_png_crop_fallback(tmp_path, monkeypatch):
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 72), "1 Method", fontsize=14, fontname="hebo")
    page.insert_text((72, 102), "A normal prose paragraph introduces our loss function clearly.", fontsize=10.5, fontname="helv")
    # Stacked / DocLayout isolate_formula candidate via multiple math lines
    page.insert_htmlbox(fitz.Rect(180, 130, 420, 148), '<p style="font-size:10.5pt;margin:0">y = w ⊗ x + b</p>')
    page.insert_htmlbox(fitz.Rect(180, 146, 420, 164), '<p style="font-size:10.5pt;margin:0">z = ∑ y ÷ N</p>')
    page.insert_text((500, 148), "(2)", fontsize=10.5, fontname="helv")
    pdf = tmp_path / "stem_ocr.pdf"
    doc.save(str(pdf))

    # Case 1: RapidLaTeXOCR succeeds with valid LaTeX.
    monkeypatch.setattr(pdf_formula, "get_latex_ocr_engine", lambda: (lambda _img: (r"y = \sum_{i=1}^N w_i x_i", 0.01)))
    layout_ok = pdf_layout.analyze_pdf(str(pdf), media=True)
    assert layout_ok["extraction_meta"]["formula_count"] == 1
    assert layout_ok["extraction_meta"]["formula_fallback_count"] == 0
    assert layout_ok["formulas"][0]["formula_latex"] == r"y = \sum_{i=1}^N w_i x_i"
    assert layout_ok["formulas"][0]["equation_number"] == "(2)"

    # Case 2: RapidLaTeXOCR returns invalid unbalanced LaTeX -> stacked multi-line falls back to 250 DPI PNG crop.
    monkeypatch.setattr(pdf_formula, "get_latex_ocr_engine", lambda: (lambda _img: (r"\frac{broken", 0.01)))
    layout_fb = pdf_layout.analyze_pdf(str(pdf), media=True)
    assert layout_fb["extraction_meta"]["formula_count"] == 1
    assert layout_fb["extraction_meta"]["formula_fallback_count"] == 1
    fb_formula = layout_fb["formulas"][0]
    assert fb_formula["used_fallback"] is True
    assert fb_formula["formula_latex"] is None
    assert fb_formula["image_bytes"].startswith(b"\x89PNG")

    structured_fb = extractor.extract_structured_sections_from_pdf(str(pdf), media=True)
    fb_blocks = [b for b in structured_fb["sections"]["method"] if b["type"] == "formula"]
    assert len(fb_blocks) == 1
    assert fb_blocks[0]["_image_bytes"].startswith(b"\x89PNG")


def test_detect_inline_formulas_skips_plain_prose_and_hyphenation():
    plain = "This state-of-the-art text-to-text pipeline achieved 92.4% precision in 2024."
    assert pdf_formula.detect_inline_formulas(plain) == []

    with_math = "Let y = wx + b with learning rate α ∈ ℝ and step ∑ xᵢ."
    found = pdf_formula.detect_inline_formulas(with_math)
    assert len(found) >= 2
    for item in found:
        snippet = with_math[item["start"]:item["end"]]
        assert snippet
        assert pdf_formula.validate_latex(item["latex"])


def test_get_latex_ocr_engine_supports_both_class_names(tmp_path, monkeypatch):
    model_dir = tmp_path / "latex_ocr"
    model_dir.mkdir(parents=True)
    for fname in ("image_resizer.onnx", "encoder.onnx", "decoder.onnx", "tokenizer.json"):
        (model_dir / fname).write_bytes(b"stub")

    monkeypatch.setenv("LATEX_OCR_MODEL_DIR", str(model_dir))
    expected_keys = ("image_resizer_path", "encoder_path", "decoder_path", "tokenizer_json")

    for attr_name in ("LaTeXOCR", "LatexOCR"):
        captured = {}

        class _FakeEngine:
            def __init__(self, **kwargs):
                captured.update(kwargs)

        pdf_formula.reset_formula_engine_cache()
        monkeypatch.setitem(sys.modules, "rapid_latex_ocr", SimpleNamespace(**{attr_name: _FakeEngine}))
        try:
            engine = pdf_formula.get_latex_ocr_engine()
            assert isinstance(engine, _FakeEngine)
            assert set(captured.keys()) == set(expected_keys)
            for key in expected_keys:
                assert isinstance(captured[key], str)
                assert captured[key].endswith(model_dir.name + "/" + key.replace("_path", ".onnx").replace("_json", ".json")) or (
                    model_dir / captured[key]
                ).is_file()
        finally:
            pdf_formula.reset_formula_engine_cache()


def test_get_latex_ocr_engine_returns_none_when_package_missing(monkeypatch):
    pdf_formula.reset_formula_engine_cache()
    monkeypatch.setenv("OCR_AUTO_DOWNLOAD", "true")
    monkeypatch.setitem(sys.modules, "rapid_latex_ocr", None)
    try:
        assert pdf_formula.get_latex_ocr_engine() is None
    finally:
        pdf_formula.reset_formula_engine_cache()
