# -*- coding: utf-8 -*-
"""
Unit and integration tests for hybrid CPU PDF extraction (`backend/pdf_ocr.py`,
`backend/pdf_layout.py`, and error handling in `backend/main.py`).
"""
from __future__ import annotations

from difflib import SequenceMatcher

import cv2
import fitz
import numpy as np
import pytest

import main
import pdf_geometry
import pdf_layout
import pdf_ocr
from extractor import extract_structured_sections_from_pdf, flatten_structured_sections
import document_model


def _char_accuracy(expected: str, actual: str) -> float:
    return SequenceMatcher(None, " ".join(expected.split()), " ".join(actual.split())).ratio()


def _rasterize_to_flattened_pdf(src_doc: fitz.Document, tmp_path, name: str = "flat.pdf", *, dpi: int = 200):
    flat = fitz.open()
    for page in src_doc:
        pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csRGB, alpha=False)
        out_page = flat.new_page(width=page.rect.width, height=page.rect.height)
        out_page.insert_image(out_page.rect, stream=pix.tobytes("png"))
    out_path = tmp_path / name
    flat.save(str(out_path))
    flat.close()
    return out_path


def test_flattened_english_pdf_extracts_with_exact_coords(tmp_path):
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    lines = [
        "1 Introduction",
        "Transformer architectures have reshaped neural machine translation.",
        "They replace recurrence with multi-head self-attention across tokens.",
    ]
    page.insert_text((72, 100), lines[0], fontsize=15, fontname="hebo")
    page.insert_text((72, 130), lines[1], fontsize=11, fontname="helv")
    page.insert_text((72, 150), lines[2], fontsize=11, fontname="helv")

    flat_pdf = _rasterize_to_flattened_pdf(doc, tmp_path, "flattened_en.pdf")
    doc.close()

    layout = pdf_layout.analyze_pdf(str(flat_pdf), media=False)
    meta = layout["extraction_meta"]
    assert meta["pipeline_version"] == 2
    assert meta["document_mode"] == "ocr"
    assert meta["ocr_pages"] == [1]

    extracted = " ".join(l["text"] for l in layout["lines"])
    assert _char_accuracy(" ".join(lines), extracted) >= 0.95

    for line in layout["lines"]:
        assert line["exact_position"] is True
        x0, y0, x1, y1 = line["bbox"]
        assert 0.0 <= x0 < x1 <= 595.0
        assert 0.0 <= y0 < y1 <= 842.0

    # End-to-end into document_model + pdf_geometry for Original PDF highlights.
    structured = extract_structured_sections_from_pdf(str(flat_pdf))
    flat_sections = flatten_structured_sections(structured)
    built = document_model.build_document(
        flat_sections,
        structured_sections=structured["sections"],
        section_order=structured["section_order"],
        extraction_meta=structured["extraction_meta"],
    )
    target = "neural machine translation"
    idx = built["text"].lower().index(target)
    report = {
        "document": built,
        "input_text": built["text"],
        "matches": [{"input_offset": {"start": idx, "end": idx + len(target)}}],
    }
    pdf_geometry.attach_pdf_rects(report, str(flat_pdf))
    rects = report["matches"][0].get("pdf_rects")
    assert rects and rects[0]["page"] == 1
    assert 60.0 <= rects[0]["x0"] < rects[0]["x1"] <= 550.0


def test_mixed_native_and_flattened_pdf_routing(tmp_path):
    doc = fitz.open()
    p1 = doc.new_page(width=595, height=842)
    p1.insert_text((72, 100), "1 Introduction", fontsize=14, fontname="hebo")
    p1.insert_text(
        (72, 130),
        "This first page is native digital text with more than thirty characters.",
        fontsize=11,
        fontname="helv",
    )

    tmp_scan = fitz.open()
    sp = tmp_scan.new_page(width=595, height=842)
    sp.insert_text((72, 120), "This second page is a scanned raster image without text.", fontsize=12, fontname="helv")
    pix = sp.get_pixmap(dpi=200, colorspace=fitz.csRGB, alpha=False)
    tmp_scan.close()

    p2 = doc.new_page(width=595, height=842)
    p2.insert_image(p2.rect, stream=pix.tobytes("png"))

    mixed_pdf = tmp_path / "mixed.pdf"
    doc.save(str(mixed_pdf))
    doc.close()

    layout = pdf_layout.analyze_pdf(str(mixed_pdf), media=False)
    meta = layout["extraction_meta"]
    assert meta["document_mode"] == "hybrid"
    assert meta["total_pages"] == 2
    assert meta["ocr_pages"] == [2]
    texts = [l["text"] for l in layout["lines"]]
    assert any("native digital text" in t for t in texts)
    assert any("scanned raster image" in t for t in texts)


def test_vietnamese_diacritic_recognizer_tier(monkeypatch, tmp_path):
    expected_vi = "Nghiên cứu xử lý ngôn ngữ tự nhiên tiếng Việt và phát hiện đạo văn."
    doc = fitz.open()
    p = doc.new_page(width=595, height=842)
    p.insert_text((72, 120), expected_vi, fontsize=12, fontname="helv")
    flat_pdf = _rasterize_to_flattened_pdf(doc, tmp_path, "vi_flat.pdf")
    doc.close()

    # Simulate the Vietnamese-preserving ONNX / Tesseract recognizer returning the line.
    monkeypatch.setattr(
        pdf_ocr,
        "ocr_image_lines",
        lambda rgb_img, *, page_number, page_width, page_height, dpi, to_orig_coords=None, region_offset=(0.0, 0.0): [
            {
                "page": page_number,
                "block": f"{page_number}:ocr_0",
                "bbox": [72.0, 108.0, 480.0, 124.0],
                "size": 12.0,
                "spans": [{"text": expected_vi, "size": 12.0, "font": "OCR", "flags": 0}],
                "text": expected_vi,
                "block_x0": 72.0,
                "block_x1": 480.0,
                "page_height": page_height,
                "exact_position": True,
                "source": "ocr",
            }
        ],
    )

    layout = pdf_layout.analyze_pdf(str(flat_pdf), media=False)
    actual = " ".join(l["text"] for l in layout["lines"])
    assert _char_accuracy(expected_vi, actual) >= 0.95
    assert "Nghiên cứu" in actual and "đạo văn" in actual


def test_skew_preprocessing_and_inverse_coordinates():
    # Render dark horizontal text lines onto white RGB image and rotate by +5 deg.
    canvas = np.full((600, 900, 3), 255, dtype=np.uint8)
    for y in (160, 210, 260, 310):
        cv2.putText(canvas, "Academic sentence alignment baseline test", (90, y), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (20, 20, 20), 2)

    mat = cv2.getRotationMatrix2D((450.0, 300.0), -5.0, 1.0)
    skewed = cv2.warpAffine(canvas, mat, (900, 600), borderValue=(255, 255, 255))

    pre = pdf_ocr.preprocess_scan_image(skewed)
    assert abs(pre.skew_angle - 5.0) < 2.0 or abs(pre.skew_angle + 5.0) < 2.0
    # Inverse coordinate mapper keeps mapped coordinates within image bounds.
    ox, oy = pre.to_orig_coords(450.0, 300.0)
    assert 400.0 <= ox <= 500.0
    assert 250.0 <= oy <= 350.0


def test_illegible_scan_appends_warning_without_crashing(monkeypatch, tmp_path):
    # Create an image with non-trivial dark smudges/noise that yield no OCR text.
    rng = np.random.default_rng(42)
    noisy = np.full((300, 300, 3), 240, dtype=np.uint8)
    noisy[100:150, 100:150] = rng.integers(0, 60, size=(50, 50, 3), dtype=np.uint8)
    _, png_bytes = cv2.imencode(".png", noisy)

    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_image(page.rect, stream=png_bytes.tobytes())
    pdf_path = tmp_path / "illegible.pdf"
    doc.save(str(pdf_path))
    doc.close()

    monkeypatch.setattr(pdf_ocr, "ocr_image_lines", lambda *a, **k: [])
    layout = pdf_layout.analyze_pdf(str(pdf_path), media=False)
    assert layout["extraction_meta"]["ocr_pages"] == [1]
    assert "page_1_illegible_scan" in layout["extraction_meta"]["warnings"]


def test_corrupted_encrypted_and_empty_pdf_errors(tmp_path):
    bad = tmp_path / "corrupt.pdf"
    bad.write_bytes(b"not a pdf at all")
    with pytest.raises(ValueError) as exc_info:
        pdf_layout.analyze_pdf(str(bad))
    assert type(exc_info.value) is ValueError
    assert str(exc_info.value) == "This PDF is password-protected or corrupted and cannot be read."

    src = fitz.open()
    p = src.new_page()
    p.insert_text((72, 100), "Secret document")
    enc = tmp_path / "encrypted.pdf"
    src.save(
        str(enc),
        encryption=fitz.PDF_ENCRYPT_AES_256,
        user_pw="secret123",
        owner_pw="owner123",
    )
    src.close()
    with pytest.raises(ValueError) as enc_err:
        pdf_layout.analyze_pdf(str(enc))
    assert type(enc_err.value) is ValueError
    assert str(enc_err.value) == "This PDF is password-protected or corrupted and cannot be read."

    blank = fitz.open()
    blank.new_page()
    blank_path = tmp_path / "blank.pdf"
    blank.save(str(blank_path))
    blank.close()
    with pytest.raises(ValueError) as empty_err:
        main.check_pdf_plagiarism(str(blank_path))
    assert type(empty_err.value) is ValueError
    assert str(empty_err.value) == "No readable text could be extracted from this PDF."
