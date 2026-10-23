# -*- coding: utf-8 -*-
"""
Part C of the extraction plan: two-column reading order (pdf_layout),
match boxes on the PDF page (pdf_geometry) and the .docx -> PDF rendering
for the Original view (docx_to_pdf).
"""
import stat
import sys

import fitz
import pytest

import docx_to_pdf
import document_model
import pdf_geometry
import pdf_layout
from extractor import extract_structured_sections_from_pdf, flatten_structured_sections

WORDS = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu".split()


def _column_text(prefix, lines):
    return [f"{prefix} line {k} " + " ".join(WORDS[(k + j) % len(WORDS)] for j in range(5)) for k in range(lines)]


def test_two_column_page_is_read_column_by_column(tmp_path):
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 70), "A Title Across Both Columns", fontsize=16, fontname="hebo")
    left, right = _column_text("Left", 12), _column_text("Right", 12)
    # The right column is drawn first, as some exporters do.
    for k, text in enumerate(right):
        page.insert_text((310, 120 + 14 * k), text, fontsize=9, fontname="helv")
    for k, text in enumerate(left):
        page.insert_text((60, 120 + 14 * k), text, fontsize=9, fontname="helv")
    pdf = tmp_path / "columns.pdf"
    doc.save(str(pdf))

    texts = [l["text"] for l in pdf_layout.analyze_pdf(str(pdf), media=False)["lines"]]
    assert texts[0] == "A Title Across Both Columns"
    assert texts[1:13] == left
    assert texts[13:] == right


def test_single_column_order_is_left_alone():
    lines = [
        {"block": f"1:{k}", "bbox": [72, 100 + 14 * k, 520, 110 + 14 * k], "text": "one two three four five six"}
        for k in range(12)
    ]
    shuffled = lines[6:] + lines[:6]
    assert pdf_layout.reading_order(shuffled) is shuffled


# --- Match boxes ---------------------------------------------------------------

def _paper(tmp_path):
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 100), "1 Introduction", fontsize=14, fontname="hebo")
    sentences = [
        "Voice conversion changes who seems to be speaking while keeping",
        "what is said. Older systems needed parallel recordings of both",
        "speakers. Our project implements a plain autoencoder instead.",
    ]
    for k, text in enumerate(sentences):
        page.insert_text((72, 130 + 13 * k), text, fontsize=10, fontname="helv")
    page.insert_text((72, 200), "2 Method", fontsize=14, fontname="hebo")
    page.insert_text((72, 230), "The method is described in this second short paragraph here.", fontsize=10, fontname="helv")
    pdf = tmp_path / "paper.pdf"
    doc.save(str(pdf))
    return pdf


def _report(pdf, phrase):
    structured = extract_structured_sections_from_pdf(str(pdf))
    flat = flatten_structured_sections(structured)
    document = document_model.build_document(
        flat, structured_sections=structured["sections"], section_order=structured["section_order"]
    )
    text = document["text"]
    start = text.index(phrase)
    return {
        "document": document,
        "input_text": text,
        "matches": [{"input_offset": {"start": start, "end": start + len(phrase)}}],
    }


def test_match_across_lines_gets_one_box_per_line_trimmed_to_its_words(tmp_path):
    pdf = _paper(tmp_path)
    phrase = "Older systems needed parallel recordings of both speakers."
    report = _report(pdf, phrase)
    pdf_geometry.attach_pdf_rects(report, str(pdf))

    rects = report["matches"][0]["pdf_rects"]
    assert [r["page"] for r in rects] == [1, 1]
    page = fitz.open(str(pdf))[0]
    first, second = (fitz.Rect(r["x0"], r["y0"], r["x1"], r["y1"]) for r in rects)
    # Starts at "Older", not at the start of its line.
    older = page.search_for("Older")[0]
    assert abs(first.x0 - older.x0) < 1
    assert first.x0 > 100
    # Ends right after "speakers." on the next line.
    speakers = page.search_for("speakers.")[0]
    assert abs(second.x1 - speakers.x1) < 1
    assert abs(second.x0 - 72) < 2
    # The carrier never reaches the saved report.
    assert not any("_geometry" in b for b in report["document"]["blocks"])


def test_whole_line_without_the_pdf_still_gets_its_box(tmp_path):
    pdf = _paper(tmp_path)
    phrase = "The method is described in this second short paragraph here."
    report = _report(pdf, phrase)
    pdf_geometry.attach_pdf_rects(report, None)
    (rect,) = report["matches"][0]["pdf_rects"]
    assert rect["page"] == 1 and rect["x0"] == pytest.approx(72, abs=1)


def test_matches_without_offsets_are_left_to_text_search(tmp_path):
    pdf = _paper(tmp_path)
    report = _report(pdf, "Voice conversion")
    report["matches"].append({"input_sentence": "no offsets here"})
    pdf_geometry.attach_pdf_rects(report, str(pdf))
    assert "pdf_rects" not in report["matches"][1]


def test_sideways_page_has_no_boxes(tmp_path):
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    for k in range(12):
        page.insert_text((100 + 20 * k, 700), f"Rotated row {k} with several words of content", fontsize=10, fontname="helv", rotate=90)
    pdf = tmp_path / "sideways.pdf"
    doc.save(str(pdf))
    report = _report(pdf, "Rotated row 3")
    pdf_geometry.attach_pdf_rects(report, str(pdf))
    assert "pdf_rects" not in report["matches"][0]


# --- .docx -> PDF ----------------------------------------------------------------

def test_no_libreoffice_means_no_rendering(tmp_path, monkeypatch):
    monkeypatch.delenv("LIBREOFFICE_BIN", raising=False)
    monkeypatch.setattr(docx_to_pdf.shutil, "which", lambda name: None)
    assert docx_to_pdf.convert_docx_to_pdf(tmp_path / "report.docx", tmp_path / "out") is None


@pytest.mark.skipif(sys.platform == "win32", reason="uses a shell-script stand-in for soffice")
def test_conversion_runs_libreoffice_headless(tmp_path, monkeypatch):
    # A stand-in for soffice that writes "<name>.pdf" into --outdir.
    fake = tmp_path / "soffice"
    fake.write_text(
        "#!/bin/sh\n"
        "while [ $# -gt 0 ]; do case \"$1\" in --outdir) out=\"$2\"; shift;; *) last=\"$1\";; esac; shift; done\n"
        "name=$(basename \"$last\" .docx)\n"
        "printf '%%PDF-1.4 fake' > \"$out/$name.pdf\"\n"
    )
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("LIBREOFFICE_BIN", str(fake))
    source = tmp_path / "Report.docx"
    source.write_bytes(b"PK fake docx")

    converted = docx_to_pdf.convert_docx_to_pdf(source, tmp_path / "out")
    assert converted == tmp_path / "out" / "Report.pdf"
    assert converted.read_bytes().startswith(b"%PDF")


def test_failed_conversion_is_not_an_error(tmp_path, monkeypatch):
    fake = tmp_path / "soffice"
    fake.write_text("#!/bin/sh\nexit 1\n")
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("LIBREOFFICE_BIN", str(fake))
    assert docx_to_pdf.convert_docx_to_pdf(tmp_path / "Report.docx", tmp_path / "out") is None


def test_docx_check_stores_its_rendering(tmp_path, monkeypatch):
    import app as api_app

    rendering = tmp_path / "Report.pdf"
    rendering.write_bytes(b"%PDF-1.4 fake")
    stored = []
    monkeypatch.setattr("docx_to_pdf.convert_docx_to_pdf", lambda path, out: rendering)
    monkeypatch.setattr(api_app, "_upload_pdf", lambda user, report, path: stored.append((user, report, path)))

    api_app._upload_docx_rendering("user-1", "report-1", tmp_path / "Report.docx")
    assert stored == [("user-1", "report-1", rendering)]
