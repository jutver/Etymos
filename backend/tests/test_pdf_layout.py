# -*- coding: utf-8 -*-
"""
Layout-aware PDF extraction (pdf_layout.py + extractor.py): page furniture,
the table of contents, heading levels, the title, tables, figures and
rotated pages.

The synthetic PDFs below are built with PyMuPDF so every rule is pinned
without the sample files. The golden tests at the end run against the
real reports in TEST_Documents/ (not committed) and skip without them.
"""
from pathlib import Path

import fitz
import pytest

import pdf_layout
from extractor import (
    extract_lines_from_pdf,
    extract_structured_sections_from_pdf,
    flatten_structured_sections,
    heading_depth,
)

BODY = (
    "This paragraph explains the work in detail and keeps going for a while "
    "so the page has enough running text to count as real body content here. "
)


class Writer:
    """Writes lines down A4 pages, one font size per call."""

    def __init__(self, doc):
        self.doc = doc
        self.page = None
        self.y = 0
        self.new_page()

    def new_page(self):
        self.page = self.doc.new_page(width=595, height=842)
        self.y = 120
        return self.page

    def line(self, text, size=10, x=72, bold=False, gap=4):
        if self.y > 720:
            self.new_page()
        self.page.insert_text((x, self.y), text, fontsize=size, fontname="hebo" if bold else "helv")
        self.y += size + gap

    def paragraph(self, words=BODY * 3, size=10):
        tokens = words.split()
        for k in range(0, len(tokens), 13):
            self.line(" ".join(tokens[k:k + 13]), size=size)
        self.y += 6


def _structure(path):
    structured = extract_structured_sections_from_pdf(str(path))
    blocks = [b for name in structured["section_order"] for b in structured["sections"].get(name, [])]
    return structured, blocks


def _png(width=80, height=40):
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, width, height), False)
    pix.set_rect(pix.irect, (30, 90, 200))
    return pix.tobytes("png")


# --- Page furniture ----------------------------------------------------------

def _report_with_running_header(path, logo=True):
    doc = fitz.open()
    w = Writer(doc)
    chapters = ["Introduction", "Dataset and Preprocessing Pipeline", "Model Architecture", "Conclusion"]
    logo_png = _png()
    for number, chapter in enumerate(chapters, start=1):
        if number > 1:
            w.new_page()
        # Running header: logo left, current chapter right, same place on
        # every page; footer: report name + page number.
        if logo:
            w.page.insert_image(fitz.Rect(72, 40, 132, 70), stream=logo_png)
        w.page.insert_text((330, 60), f"{number} {chapter}", fontsize=10, fontname="helv")
        w.page.insert_text((250, 800), "Project Final Report", fontsize=10, fontname="helv")
        w.page.insert_text((505, 800), str(number), fontsize=10, fontname="helv")
        w.line(f"{number} {chapter}", size=14, bold=True, gap=10)
        w.paragraph()
        w.line(f"{number}.1 First Part", size=12, bold=True, gap=8)
        w.paragraph()
    doc.save(str(path))


def test_running_header_footer_and_logo_are_not_content(tmp_path):
    pdf = tmp_path / "report.pdf"
    _report_with_running_header(pdf)
    layout = pdf_layout.analyze_pdf(str(pdf))
    texts = [l["text"] for l in layout["lines"]]

    assert "Project Final Report" not in texts
    assert not any(t.isdigit() for t in texts)
    # The logo is on every page: decoration, not a figure.
    assert layout["figures"] == []


def test_heading_repeated_by_the_running_header_is_kept(tmp_path):
    pdf = tmp_path / "report.pdf"
    _report_with_running_header(pdf, logo=False)
    _structured, blocks = _structure(pdf)
    headings = [b["text"] for b in blocks if b["type"] == "heading"]

    # The running header prints "2 Dataset and Preprocessing Pipeline" on
    # its pages too; only the header copy is furniture.
    assert headings.count("2 Dataset and Preprocessing Pipeline") == 1


# --- Table of contents --------------------------------------------------------

def test_table_of_contents_is_left_out(tmp_path):
    doc = fitz.open()
    w = Writer(doc)
    w.line("Contents", size=14, bold=True, gap=10)
    for number, (title, page) in enumerate([("Introduction", 2), ("Related Work", 2), ("Method", 3), ("Results", 4)], start=1):
        w.line(f"{number}  {title}", x=72)
        w.page.insert_text((505, w.y - 14), str(page), fontsize=10, fontname="helv")
        w.line(f"{number}.1  Details of {title.lower()} " + ". " * 20, x=86)
        w.page.insert_text((505, w.y - 14), str(page), fontsize=10, fontname="helv")
    w.new_page()
    for number, title in enumerate(["Introduction", "Related Work", "Method", "Results"], start=1):
        w.line(f"{number} {title}", size=14, bold=True, gap=10)
        w.paragraph()
    pdf = tmp_path / "toc.pdf"
    doc.save(str(pdf))

    lines = extract_lines_from_pdf(str(pdf))
    assert not any(l["text"] == "Contents" for l in lines)
    assert all(l["page"] == 2 for l in lines)
    _structured, blocks = _structure(pdf)
    headings = [b for b in blocks if b["type"] == "heading"]
    assert [h["text"] for h in headings] == ["1 Introduction", "2 Related Work", "3 Method", "4 Results"]


# --- Headings ------------------------------------------------------------------

@pytest.mark.parametrize("text, depth", [
    ("3 Method", 1),
    ("3.1 Data", 2),
    ("3.1.2 Cleaning", 3),
    ("3.1.2.1 Tokens", 4),
    ("A.1 Proofs", 2),
    ("IV. RESULTS", 1),
    ("Chapter 2 Background", 0),
    ("Chương 2 Tổng quan", 0),
    ("Related Work", None),
    ("A Study of Things", None),
])
def test_heading_depth_from_numbering(text, depth):
    assert heading_depth(text) == depth


def test_heading_levels_follow_the_numbering(tmp_path):
    doc = fitz.open()
    w = Writer(doc)
    w.line("1 Introduction", size=14, bold=True, gap=10)
    w.paragraph()
    w.line("2 Method", size=14, bold=True, gap=10)
    w.paragraph()
    w.line("2.1 Data Collection", size=12, bold=True, gap=8)
    w.paragraph()
    w.line("2.1.1 Cleaning Steps", size=10.5, bold=True, gap=8)
    w.paragraph()
    w.line("3 Conclusion", size=14, bold=True, gap=10)
    w.paragraph()
    pdf = tmp_path / "levels.pdf"
    doc.save(str(pdf))

    _structured, blocks = _structure(pdf)
    levels = {b["text"]: b["level"] for b in blocks if b["type"] == "heading"}
    assert levels["2 Method"] == 2
    assert levels["2.1 Data Collection"] == 3
    assert levels["2.1.1 Cleaning Steps"] == 4


def test_roman_parts_nest_the_arabic_sections(tmp_path):
    doc = fitz.open()
    w = Writer(doc)
    for part, sections in (("I. INTRODUCTION:", ["1. Background:", "2. Problem statement:"]),
                           ("II. ANALYSIS:", ["1. PEST analysis:", "2. SWOT analysis:"])):
        w.line(part, size=13, bold=True, gap=10)
        for section in sections:
            w.line(section, size=12, bold=True, gap=8)
            w.paragraph()
    pdf = tmp_path / "roman.pdf"
    doc.save(str(pdf))

    _structured, blocks = _structure(pdf)
    levels = {b["text"]: b["level"] for b in blocks if b["type"] == "heading"}
    assert levels["II. ANALYSIS:"] == 2
    # Numbering restarts under each part, and those are not mis-detections.
    assert levels["1. PEST analysis:"] == 3
    assert levels["2. SWOT analysis:"] == 3


def test_numbered_list_steps_are_not_sections(tmp_path):
    doc = fitz.open()
    w = Writer(doc)
    w.line("1 Introduction", size=14, bold=True, gap=10)
    w.paragraph()
    w.line("2 Method", size=14, bold=True, gap=10)
    w.paragraph(BODY)
    w.line("1. Resample the audio to 16 kHz.", x=86)
    w.line("2. Save the result to disk.", x=86)
    w.paragraph()
    w.line("3 Results", size=14, bold=True, gap=10)
    w.paragraph()
    pdf = tmp_path / "steps.pdf"
    doc.save(str(pdf))

    _structured, blocks = _structure(pdf)
    headings = [b["text"] for b in blocks if b["type"] == "heading"]
    assert headings == ["1 Introduction", "2 Method", "3 Results"]


# --- Title -----------------------------------------------------------------------

def test_title_and_subtitle(tmp_path):
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((150, 250), "Project Final Report", fontsize=22, fontname="hebo")
    page.insert_text((130, 330), "Voice Conversion using Disentanglement", fontsize=17, fontname="helv")
    page.insert_text((200, 400), "Dinh Minh Quan 1 , Trinh Thanh An 2", fontsize=13, fontname="helv")
    w = Writer(doc)
    w.line("1 Introduction", size=14, bold=True, gap=10)
    w.paragraph()
    w.line("2 Method", size=14, bold=True, gap=10)
    w.paragraph()
    pdf = tmp_path / "cover.pdf"
    doc.save(str(pdf))

    structured, _blocks = _structure(pdf)
    titles = [(b["text"], b["level"]) for b in structured["sections"]["title"]]
    assert titles == [("Project Final Report", 1), ("Voice Conversion using Disentanglement", 2)]
    # The author line is neither, and stays in the document.
    assert "Dinh Minh Quan" in flatten_structured_sections(structured)["front_matter"]


# --- Tables ------------------------------------------------------------------------

def _table_page(w, caption, header, rows, x=110, widths=(150, 120, 120)):
    w.paragraph(BODY)
    w.line(caption)
    top = w.y - 6
    w.page.draw_line((x - 4, top), (x + sum(widths), top), width=0.8)
    w.y += 8

    def row(cells):
        cx = x
        for cell, width in zip(cells, widths):
            w.page.insert_text((cx, w.y), cell, fontsize=9, fontname="helv")
            cx += width
        w.y += 13

    row(header)
    w.page.draw_line((x - 4, w.y - 9), (x + sum(widths), w.y - 9), width=0.5)
    for cells in rows:
        row(cells)
    w.page.draw_line((x - 4, w.y - 7), (x + sum(widths), w.y - 7), width=0.8)
    w.y += 14
    w.paragraph(BODY)


def test_captioned_table_is_read_as_a_grid(tmp_path):
    doc = fitz.open()
    w = Writer(doc)
    w.line("1 Results", size=14, bold=True, gap=10)
    _table_page(
        w, "Table 1: Comparison of bottleneck configurations.",
        ["Model", "Reconstruction Error", "Speaker Accuracy"],
        [["Too Narrow", "34.6", "7.50%"], ["AutoVC (standard)", "8.59", "12.0%"], ["Too Wide", "6.31", "41.2%"]],
    )
    pdf = tmp_path / "table.pdf"
    doc.save(str(pdf))

    _structured, blocks = _structure(pdf)
    tables = [b for b in blocks if b["type"] == "table"]
    assert len(tables) == 1
    assert tables[0]["rows"] == [
        ["Model", "Reconstruction Error", "Speaker Accuracy"],
        ["Too Narrow", "34.6", "7.50%"],
        ["AutoVC (standard)", "8.59", "12.0%"],
        ["Too Wide", "6.31", "41.2%"],
    ]
    assert "_image_bytes" not in tables[0]
    # It comes right after its caption, and its cells are not loose text.
    index = blocks.index(tables[0])
    assert blocks[index - 1]["text"].startswith("Table 1:")
    assert not any(b["type"] == "paragraph" and "Too Narrow" in b["text"] for b in blocks)
    # Table text is still part of the checked text, without newlines.
    flat = flatten_structured_sections(_structured)
    assert "AutoVC (standard) | 8.59 | 12.0%" in " ".join(v for v in flat.values() if isinstance(v, str))


def test_uncaptioned_ruled_text_is_not_a_table(tmp_path):
    doc = fitz.open()
    w = Writer(doc)
    w.line("1 Method", size=14, bold=True, gap=10)
    w.line("Algorithm 1: Upsampling with kernels")
    w.page.draw_line((70, w.y - 6), (520, w.y - 6), width=0.8)
    w.y += 6
    for step in ("1  def upsample(x):", "2      return interpolate(x)", "3  # end"):
        w.line(step, x=90)
    w.page.draw_line((70, w.y - 6), (520, w.y - 6), width=0.8)
    w.paragraph()
    pdf = tmp_path / "algorithm.pdf"
    doc.save(str(pdf))

    _structured, blocks = _structure(pdf)
    assert not [b for b in blocks if b["type"] == "table"]


def test_unreliable_grid_is_shown_as_a_picture():
    sparse = [["Group", "", "", "", ""], ["", "a", "", "", ""], ["", "", "b", "", ""], ["x", "", "", "", "c"]]
    assert pdf_layout._grid_is_reliable(sparse) is False
    assert pdf_layout._grid_is_reliable([["a", "b"], ["1", "2"]]) is True
    assert pdf_layout._grid_is_reliable([["c"] * 11, ["1"] * 11]) is False


# --- Figures ------------------------------------------------------------------------

def test_vector_figure_with_caption_becomes_an_image_in_place(tmp_path):
    doc = fitz.open()
    w = Writer(doc)
    w.line("1 Method", size=14, bold=True, gap=10)
    w.paragraph()
    top = w.y
    shape = w.page.new_shape()
    shape.draw_rect(fitz.Rect(110, top, 360, top + 160))
    shape.draw_circle((180, top + 80), 40)
    shape.draw_line((220, top + 80), (330, top + 80))
    shape.finish(color=(0, 0, 0), width=1)
    shape.commit()
    w.page.insert_text((160, top + 150), "encoder", fontsize=6, fontname="helv")
    w.y = top + 180
    w.line("Figure 1: Overview of the pipeline.", gap=16)
    w.paragraph()
    pdf = tmp_path / "figure.pdf"
    doc.save(str(pdf))

    _structured, blocks = _structure(pdf)
    kinds = [b["type"] for b in blocks]
    image = kinds.index("image")
    assert blocks[image]["_image_bytes"].startswith(b"\x89PNG")
    assert blocks[image + 1]["text"].startswith("Figure 1:")
    # The label drawn inside the figure belongs to the picture.
    assert not any("encoder" == b["text"] for b in blocks)


# --- Rotated pages -------------------------------------------------------------------

def test_rotated_page_is_read_upright(tmp_path):
    doc = fitz.open()
    w = Writer(doc)
    w.line("1 Introduction", size=14, bold=True, gap=10)
    w.paragraph()
    page = doc.new_page(width=595, height=842)
    # A landscape page set sideways: every line runs bottom to top.
    for k in range(12):
        page.insert_text((100 + 20 * k, 700), f"Rotated row {k} with several words of content", fontsize=10, fontname="helv", rotate=90)
    pdf = tmp_path / "rotated.pdf"
    doc.save(str(pdf))

    layout = pdf_layout.analyze_pdf(str(pdf))
    assert layout["rotated_pages"] == [2]
    rows = [l["text"] for l in layout["lines"] if l["page"] == 2]
    assert rows[0] == "Rotated row 0 with several words of content"
    assert len(rows) == 12


def test_stray_vertical_line_is_dropped(tmp_path):
    doc = fitz.open()
    w = Writer(doc)
    w.paragraph()
    w.page.insert_text((30, 600), "arXiv:2401.00001v1 [cs.CL] 1 Jan 2024", fontsize=10, fontname="helv", rotate=90)
    pdf = tmp_path / "stamp.pdf"
    doc.save(str(pdf))

    assert not any("arXiv" in l["text"] for l in extract_lines_from_pdf(str(pdf)))


# --- Paragraphs -----------------------------------------------------------------------

def test_paragraphs_are_split_where_the_layout_shows_it(tmp_path):
    doc = fitz.open()
    w = Writer(doc)
    w.line("1 Introduction", size=14, bold=True, gap=10)
    w.line("First paragraph opens here and runs on for a whole line of text.")
    w.line("It ends on this shorter line.")
    w.line("Second paragraph starts indented and runs on for a whole line.", x=90)
    w.line("It also ends here.")
    pdf = tmp_path / "paragraphs.pdf"
    doc.save(str(pdf))

    _structured, blocks = _structure(pdf)
    paragraphs = [b["text"] for b in blocks if b["type"] == "paragraph"]
    assert paragraphs == [
        "First paragraph opens here and runs on for a whole line of text. It ends on this shorter line.",
        "Second paragraph starts indented and runs on for a whole line. It also ends here.",
    ]


# --- Golden tests on the sample reports ------------------------------------------------

SAMPLES = Path(__file__).resolve().parents[2] / "TEST_Documents"


def _sample(name):
    path = SAMPLES / name
    if not path.exists():
        pytest.skip(f"{name} is not in TEST_Documents/")
    return path


def test_golden_slp301_report():
    structured, blocks = _structure(_sample("SLP301_Final_Report.pdf"))
    headings = {b["text"]: b["level"] for b in blocks if b["type"] == "heading"}

    assert [(b["text"], b["level"]) for b in structured["sections"]["title"]] == [
        ("Project Final Report", 1), ("Voice Conversion using Disentanglement", 2),
    ]
    # The FPT logo is on every page: no image comes before the first figure.
    images = [b for b in blocks if b["type"] == "image"]
    assert len(images) == 3
    assert blocks[blocks.index(images[0]) + 1]["text"].startswith("Figure 1:")
    # The table of contents is gone, the real headings keep their numbers.
    assert headings["3 Dataset and Preprocessing Pipeline"] == 2
    assert headings["3.1 Dataset"] == 3
    assert list(headings).count("4 Model Architecture") == 1
    table = next(b for b in blocks if b["type"] == "table")
    assert table["rows"][0] == ["Model", "Reconstruction Error", "Speaker Classification Accuracy"]
    assert table["rows"][1] == ["Too Narrow", "34.6", "7.50%"]


def test_golden_vihatet5_paper():
    _structured, blocks = _structure(_sample("VIHateT5.pdf"))
    tables = [b for b in blocks if b["type"] == "table"]

    assert len(tables) == 10
    # Table 11 is set sideways on its page: read upright, shown as a picture.
    rotated = [t for t in tables if t["page"] == 14]
    assert len(rotated) == 1 and rotated[0]["_image_bytes"].startswith(b"\x89PNG")
    assert any(b["text"] == "4.3.1 Multilingual Pre-trained Models" and b["level"] == 4 for b in blocks)
    # The arXiv stamp up the side of page 1 ("arXiv:2405.14141v1 [cs.CL]
    # ..."); arXiv ids in the references stay.
    text = " ".join(b["text"] for b in blocks)
    assert "[cs." not in text


def test_golden_mednext_two_column_paper():
    _structured, blocks = _structure(_sample("2303.09975v5.pdf"))
    tables = [b for b in blocks if b["type"] == "table"]
    # Table 3 only: the ruled algorithm listing is not a table.
    assert len(tables) == 1
    assert len([b for b in blocks if b["type"] == "image"]) == 1
