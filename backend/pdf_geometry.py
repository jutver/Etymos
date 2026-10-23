"""
pdf_geometry.py
---------------
Where each match sits in the original PDF, so the Original view can draw
its highlight from coordinates instead of searching the page text for the
matched sentence (which misses across hyphenation, ligatures and column
breaks, and can land on the wrong copy of a repeated phrase).

The extractor records, for every text block, the page and box of each of
its lines (`_geometry`, see extractor._stamp_positions). Matches carry
character offsets into the document text. This module maps one onto the
other:

    match [start, end)  ->  the lines it overlaps  ->  one box per line,
    trimmed to the exact characters on the first and last line.

Boxes are in PDF points from the page's top-left corner (PyMuPDF's
coordinates), the same frame pdf.js lays a page out in, so the viewer only
multiplies by its zoom. Lines on a page the PDF rotates, or on a sideways
page the extractor read through an upright copy, have no `_geometry`;
matches there keep the text-search highlight.
"""

from __future__ import annotations

import logging
import re

import fitz

logger = logging.getLogger(__name__)

# Characters extractor.clean_text drops or turns into spaces, plus the
# zero-width characters line_from_layout strips: ignored on both sides when
# lining the PDF's characters up with the extracted text.
_IGNORED_CHARS = {"—", "￾", "​", "‌", "‍", "⁠", "﻿"}
_LIST_MARKER_RE = re.compile(r"^\s*(?:[•‣◦●○▪▫\-*]|\(?\d{1,3}[.)]|\(?[a-z][.)])\s+")


def line_entries(document: dict, text: str) -> list[dict]:
    """
    Every positioned line as {"start", "end", "page", "bbox", "text"}, with
    start/end its offsets in `text`. Pops `_geometry` off the blocks: it is
    an in-process carrier and must not reach the saved report.
    """
    entries = []
    for block in (document or {}).get("blocks") or []:
        geometry = block.pop("_geometry", None)
        if not geometry:
            continue
        start, end = block.get("start"), block.get("end")
        if start is None or end is None or end <= start:
            continue
        segment = text[start:end]
        cursor = 0
        for line in geometry:
            needle = line.get("text") or ""
            index = segment.find(needle, cursor) if needle else -1
            marker_chars = 0
            if index < 0 and needle:
                # A list item's first line still has its bullet; the block's
                # text does not. Its characters are skipped on the page too.
                stripped = _LIST_MARKER_RE.sub("", needle, count=1)
                if stripped != needle and stripped:
                    index = segment.find(stripped, cursor)
                    marker = needle[: len(needle) - len(stripped)]
                    marker_chars = sum(1 for c in marker if c.strip() and c not in _IGNORED_CHARS)
                    needle = stripped
            if index < 0:
                continue
            entries.append({
                "start": start + index,
                "end": start + index + len(needle),
                "page": line["page"],
                "bbox": line["bbox"],
                "text": needle,
                "marker_chars": marker_chars,
            })
            cursor = index + len(needle)
    entries.sort(key=lambda e: e["start"])
    return entries


class _PageChars:
    """The PDF's own character boxes, read once per page, to trim a box to
    the exact characters a match starts or ends on."""

    def __init__(self, doc):
        self.doc = doc
        self.cache: dict[int, list] = {}

    def chars(self, page_number: int) -> list:
        if page_number not in self.cache:
            found = []
            try:
                data = self.doc[page_number - 1].get_text("rawdict")
                for block in data.get("blocks", []):
                    for line in block.get("lines", []):
                        for span in line.get("spans", []):
                            found.extend(span.get("chars", []))
            except Exception:
                logger.exception("Could not read character boxes on page %d", page_number)
            self.cache[page_number] = found
        return self.cache[page_number]

    def in_box(self, page_number: int, bbox) -> list:
        x0, y0, x1, y1 = bbox
        result = []
        for char in self.chars(page_number):
            c = char.get("c", "")
            if not c.strip() or c in _IGNORED_CHARS:
                continue
            cx0, cy0, cx1, cy1 = char["bbox"]
            cx, cy = (cx0 + cx1) / 2, (cy0 + cy1) / 2
            if x0 - 1 <= cx <= x1 + 1 and y0 - 1 <= cy <= y1 + 1:
                result.append(char)
        return result


def _x_range(entry: dict, local_start: int, local_end: int, page_chars: _PageChars | None):
    """x extent of characters [local_start, local_end) of a line."""
    x0, _y0, x1, _y1 = entry["bbox"]
    line_text = entry["text"]
    visible = [i for i, c in enumerate(line_text) if c.strip() and c not in _IGNORED_CHARS]
    chars = page_chars.in_box(entry["page"], entry["bbox"]) if page_chars else []
    if entry.get("marker_chars") and len(chars) == len(visible) + entry["marker_chars"]:
        chars = chars[entry["marker_chars"]:]
    first = next((k for k, i in enumerate(visible) if i >= local_start), None)
    last = next((k for k in range(len(visible) - 1, -1, -1) if visible[k] < local_end), None)
    if first is None or last is None or last < first:
        return None
    if len(chars) == len(visible):
        return chars[first]["bbox"][0], chars[last]["bbox"][2]
    # The PDF's characters don't line up one to one with the extracted text
    # (a ligature, a glyph drawn twice): share the line's width by position.
    width = x1 - x0
    count = max(len(visible), 1)
    return x0 + width * first / count, x0 + width * (last + 1) / count


def rects_for_range(entries: list[dict], start: int, end: int, page_chars: _PageChars | None = None) -> list[dict]:
    """One box per line the range [start, end) covers, trimmed on lines it
    only partly covers."""
    rects = []
    for entry in entries:
        if entry["end"] <= start:
            continue
        if entry["start"] >= end:
            break
        local_start = max(start, entry["start"]) - entry["start"]
        local_end = min(end, entry["end"]) - entry["start"]
        x0, y0, x1, y1 = entry["bbox"]
        if local_start > 0 or local_end < len(entry["text"]) or entry.get("marker_chars"):
            trimmed = _x_range(entry, local_start, local_end, page_chars)
            if trimmed is None:
                continue
            x0, x1 = trimmed
        if x1 - x0 < 0.5:
            continue
        rects.append({
            "page": entry["page"],
            "x0": round(x0, 1), "y0": round(y0, 1), "x1": round(x1, 1), "y1": round(y1, 1),
        })
    return rects


def attach_pdf_rects(report: dict, pdf_path: str | None) -> None:
    """
    Give every match (and AI-flagged paragraph) with offsets its
    `pdf_rects`: [{"page", "x0", "y0", "x1", "y1"}] in PDF points.

    Always removes the blocks' `_geometry`, even when nothing can be
    placed. Never raises: highlights fall back to text search without it.
    """
    document = report.get("document") or {}
    try:
        entries = line_entries(document, report.get("input_text") or "")
    except Exception:
        logger.exception("Could not map the document's lines to PDF positions.")
        for block in document.get("blocks") or []:
            block.pop("_geometry", None)
        return
    if not entries:
        return

    doc = None
    try:
        doc = fitz.open(pdf_path) if pdf_path else None
    except Exception:
        logger.exception("Could not reopen %s for character positions; boxes stay whole-line.", pdf_path)
    page_chars = _PageChars(doc) if doc is not None else None
    try:
        for match in report.get("matches") or []:
            offset = match.get("input_offset") or {}
            if offset.get("start") is None or offset.get("end") is None:
                continue
            rects = rects_for_range(entries, offset["start"], offset["end"], page_chars)
            if rects:
                match["pdf_rects"] = rects
        for segment in (report.get("ai_detection") or {}).get("segments") or []:
            if segment.get("start") is None or segment.get("end") is None:
                continue
            rects = rects_for_range(entries, segment["start"], segment["end"], page_chars)
            if rects:
                segment["pdf_rects"] = rects
    except Exception:
        logger.exception("Could not place matches on the PDF pages.")
    finally:
        if doc is not None:
            doc.close()
