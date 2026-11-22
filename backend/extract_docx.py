"""
extract_docx.py
----------------
.docx counterpart to extractor.py's PDF extraction. Produces the same
structured-block shape extractor.extract_structured_sections_from_pdf()
does — {"title": str, "sections": {section_name: [block, ...]}}, where each
block is {"type", "level", "list_type", "text", "page", "rows"?} — so both
paths feed document_model.build_document() identically and the Document
view renders either kind of upload the same way.

Unlike the PDF path, .docx documents are essentially never organized as
abstract/introduction/method/... (that taxonomy is PDF-academic-paper
specific), so there is no reliable heading vocabulary to sort content by
section. Everything therefore lands in the single "body" catch-all section
that extractor.py already defines for exactly this "just keep everything,
in order, and let block-type carry the structure" situation — see
extractor.FALLBACK_SECTION.

Unlike PDF text extraction (which reads glyph positions off a rendered
page), python-docx reads the document's own XML structure directly, so
heading level and list membership come from real paragraph styles / list
formatting rather than a font-size heuristic. This is why the .docx path
recovers headings/lists more reliably than the PDF path can.
"""

from __future__ import annotations

import logging

from docx import Document
from docx.oxml.ns import qn
from docx.table import Table
from docx.text.paragraph import Paragraph

from extractor import clean_text, LIST_MARKER_RE, LIST_NUMBER_PREFIX_RE, BULLET_MARKER_CHARS, FALLBACK_SECTION
from extractor import compute_text_marks

logger = logging.getLogger(__name__)

HEADING_STYLE_LEVEL = {
    "title": 1,
    "heading 1": 1,
    "heading 2": 2,
    "heading 3": 3,
    "heading 4": 3,
    "heading 5": 3,
    "heading 6": 3,
}

# Word does not expose real page boundaries at the XML level — pagination
# is a rendering-time concern that depends on fonts, margins, and the
# renderer. We honour EXPLICIT page breaks (Ctrl+Enter / "Insert > Page
# Break") when present in the XML, and otherwise bucket every N blocks into
# a synthetic page so the Document view still renders real blank-space
# page gaps instead of one endless strip. This is a known, documented
# limitation of the .docx path: synthetic pages will not line up with
# Word's own pagination exactly.
BLOCKS_PER_SYNTHETIC_PAGE = 14


def _iter_block_items(document: Document):
    """
    Yield paragraphs and tables in true document order.

    python-docx's `document.paragraphs` / `document.tables` accessors each
    flatten their own kind and lose how they interleave — a table in the
    middle of the text would otherwise get moved to the end. Walking the
    body's XML children directly (the standard python-docx idiom for this)
    preserves the real reading order.
    """
    body = document.element.body
    for child in body.iterchildren():
        if child.tag == qn("w:p"):
            yield Paragraph(child, document)
        elif child.tag == qn("w:tbl"):
            yield Table(child, document)


def _has_hard_page_break(paragraph: Paragraph) -> bool:
    for br in paragraph._p.findall(".//" + qn("w:br")):
        if br.get(qn("w:type")) == "page":
            return True
    return False


_NUMBERED_NUMFMTS = {
    "decimal",
    "decimalzero",
    "lowerletter",
    "upperletter",
    "lowerroman",
    "upperroman",
    "ordinal",
    "cardinaltext",
    "ordinaltext",
}


def _numbering_definitions(document: Document) -> tuple[dict[str, str], dict[tuple[str, int], dict], dict[tuple[str, int], int]]:
    """Read numbering.xml mappings so direct and styled DOCX lists keep true bullet/number types and start numbers."""
    num_to_abstract: dict[str, str] = {}
    level_meta: dict[tuple[str, int], dict] = {}
    num_start_override: dict[tuple[str, int], int] = {}
    try:
        numbering_part = document.part.numbering_part
        numbering_el = numbering_part.numbering_definitions._numbering if numbering_part is not None else None
    except Exception:
        return num_to_abstract, level_meta, num_start_override
    if numbering_el is None:
        return num_to_abstract, level_meta, num_start_override

    for abstract in numbering_el.findall(qn("w:abstractNum")):
        abs_id = abstract.get(qn("w:abstractNumId"))
        if abs_id is None:
            continue
        for lvl in abstract.findall(qn("w:lvl")):
            ilvl_raw = lvl.get(qn("w:ilvl"))
            try:
                ilvl = max(0, min(4, int(ilvl_raw or 0)))
            except ValueError:
                ilvl = 0
            num_fmt_el = lvl.find(qn("w:numFmt"))
            num_fmt = (num_fmt_el.get(qn("w:val")) or "").lower() if num_fmt_el is not None else ""
            start_el = lvl.find(qn("w:start"))
            try:
                start_val = max(1, int(start_el.get(qn("w:val")))) if start_el is not None else 1
            except (TypeError, ValueError):
                start_val = 1
            list_type = "number" if num_fmt in _NUMBERED_NUMFMTS else "bullet"
            level_meta[(abs_id, ilvl)] = {"list_type": list_type, "start": start_val}

    for num_el in numbering_el.findall(qn("w:num")):
        num_id = num_el.get(qn("w:numId"))
        abs_el = num_el.find(qn("w:abstractNumId"))
        abs_id = abs_el.get(qn("w:val")) if abs_el is not None else None
        if num_id is not None and abs_id is not None:
            num_to_abstract[num_id] = abs_id
        if num_id is not None:
            for override in num_el.findall(qn("w:lvlOverride")):
                try:
                    ilvl = max(0, min(4, int(override.get(qn("w:ilvl")) or 0)))
                except ValueError:
                    ilvl = 0
                start_ov = override.find(qn("w:startOverride"))
                if start_ov is not None:
                    try:
                        num_start_override[(num_id, ilvl)] = max(1, int(start_ov.get(qn("w:val"))))
                    except (TypeError, ValueError):
                        pass

    return num_to_abstract, level_meta, num_start_override


def _paragraph_num_pr(paragraph: Paragraph) -> tuple[str | None, int]:
    """Return (numId, clamped ilvl 0..4) from paragraph pPr or its style pPr."""
    p_pr_candidates = []
    if paragraph._p.pPr is not None:
        p_pr_candidates.append(paragraph._p.pPr)
    if paragraph.style is not None and getattr(paragraph.style._element, "pPr", None) is not None:
        p_pr_candidates.append(paragraph.style._element.pPr)

    num_id: str | None = None
    ilvl = 0
    found_ilvl = False
    for p_pr in p_pr_candidates:
        num_pr = p_pr.numPr
        if num_pr is None:
            continue
        if num_id is None and num_pr.numId is not None and num_pr.numId.val is not None:
            raw_id = str(num_pr.numId.val)
            if raw_id != "0":
                num_id = raw_id
        if not found_ilvl and num_pr.ilvl is not None and num_pr.ilvl.val is not None:
            try:
                ilvl = max(0, min(4, int(num_pr.ilvl.val)))
                found_ilvl = True
            except (TypeError, ValueError):
                pass
    return num_id, ilvl


def _manual_list_number(text: str) -> int | None:
    match = LIST_NUMBER_PREFIX_RE.match(text or "")
    if not match:
        return None
    val = int(match.group(1))
    return val if val >= 1 else None


def _list_type_from_style(
    paragraph: Paragraph,
    numbering_defs: tuple[dict[str, str], dict[tuple[str, int], dict], dict[tuple[str, int], int]] | None = None,
) -> tuple[str | None, str | None, int, int | None]:
    num_id, ilvl = _paragraph_num_pr(paragraph)
    if num_id is not None and numbering_defs is not None:
        num_to_abstract, level_meta, num_start_override = numbering_defs
        abs_id = num_to_abstract.get(num_id)
        if abs_id is not None and (abs_id, ilvl) in level_meta:
            meta = level_meta[(abs_id, ilvl)]
            start_val = num_start_override.get((num_id, ilvl), meta["start"])
            return meta["list_type"], num_id, ilvl, start_val

    style_name = (paragraph.style.name or "").lower() if paragraph.style else ""
    if "bullet" in style_name:
        return "bullet", num_id, ilvl, None
    if "number" in style_name:
        return "number", num_id, ilvl, 1

    p_pr = paragraph._p.pPr
    if (p_pr is not None and p_pr.numPr is not None) or num_id is not None:
        return "bullet", num_id, ilvl, None

    return None, None, 0, None


def _strip_manual_marker(text: str) -> tuple[str, str | None]:
    """Some documents fake a list with literal '- ' / '1. ' text instead of
    real list formatting. Recognize that the same way the PDF path does."""
    marker = LIST_MARKER_RE.match(text)
    if not marker:
        return text, None
    stripped = text[marker.end():].strip()
    if not stripped:
        return text, None
    marker_text = marker.group(0).strip()
    list_type = "bullet" if marker_text[:1] in BULLET_MARKER_CHARS else "number"
    return stripped, list_type


def _paragraph_runs(paragraph: Paragraph) -> list[tuple[str, bool, bool]]:
    """(text, bold, italic) for every run, in order - including runs inside
    hyperlinks, which paragraph.text also includes."""
    runs = []
    try:
        items = list(paragraph.iter_inner_content())
    except AttributeError:
        items = list(paragraph.runs)
    for item in items:
        item_runs = getattr(item, "runs", None)
        for run in (item_runs if item_runs is not None else [item]):
            style_name = ((run.style.name if run.style is not None else "") or "").lower()
            runs.append((
                run.text or "",
                bool(run.bold) or "strong" in style_name,
                bool(run.italic) or "emphasis" in style_name,
            ))
    return runs


def _with_marks(block: dict, paragraph: Paragraph) -> dict:
    try:
        marks = compute_text_marks(_paragraph_runs(paragraph), "", block["text"])
    except Exception:
        logger.exception("Could not compute inline marks for a docx paragraph.")
        marks = []
    if marks:
        block["marks"] = marks
    return block


def _paragraph_block(
    paragraph: Paragraph,
    page: int,
    numbering_defs: tuple[dict[str, str], dict[tuple[str, int], dict], dict[tuple[str, int], int]] | None = None,
    list_counters: dict[str, dict[int, int]] | None = None,
) -> dict | None:
    # clean_text() already collapses any manual-line-break "\n" python-docx
    # renders inside paragraph.text; the extra .replace is a defensive
    # no-op belt-and-braces guard, not load-bearing today. See the comment
    # in _table_block for why a stray "\n" here would be a silent
    # structure-loss bug for the whole section, not just a cosmetic one.
    text = clean_text(paragraph.text).replace("\n", " ").strip()
    if not text:
        return None

    style_name = (paragraph.style.name or "").lower() if paragraph.style else ""
    level = HEADING_STYLE_LEVEL.get(style_name)
    if level is not None:
        if list_counters is not None:
            list_counters.pop("__manual__", None)
        return {"type": "heading", "level": level, "list_type": None, "text": text, "page": page}

    list_type, num_id, ilvl, start_val = _list_type_from_style(paragraph, numbering_defs)
    stripped, manual_type = _strip_manual_marker(text)
    manual_num = _manual_list_number(text) if manual_type == "number" else None

    if list_type or manual_type:
        effective_type = manual_type or list_type
        depth = max(0, min(4, ilvl))
        block = {
            "type": "list_item",
            "level": None,
            "list_type": effective_type,
            "list_depth": depth,
            "text": stripped if manual_type else text,
            "page": page,
        }
        if effective_type == "number":
            scope_key = num_id or "__manual__"
            if list_counters is not None:
                scope = list_counters.setdefault(scope_key, {})
                for d in [k for k in scope if k > depth]:
                    del scope[d]
                prev = scope.get(depth)
                if manual_num is not None:
                    num = manual_num
                elif prev is not None:
                    num = prev + 1
                else:
                    num = start_val if start_val is not None else 1
                scope[depth] = num
            else:
                num = manual_num if manual_num is not None else (start_val if start_val is not None else 1)
            block["list_number"] = num
        elif list_counters is not None and not num_id:
            list_counters.pop("__manual__", None)
        return _with_marks(block, paragraph)

    if list_counters is not None:
        list_counters.pop("__manual__", None)

    return _with_marks(
        {"type": "paragraph", "level": None, "list_type": None, "text": text, "page": page},
        paragraph,
    )


# Maps the OOXML relationship part's content-type to a file extension for
# the Storage upload key (see report_store._extract_and_upload_images).
# Anything not listed falls back to "png" — a wrong extension on a rare
# format is a cosmetic filename mismatch, not a data-loss risk, since the
# bytes themselves (and the upload's explicit content-type) are unaffected.
_IMAGE_EXT_BY_CONTENT_TYPE = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
    "image/x-emf": "emf",
    "image/x-wmf": "wmf",
}


def _paragraph_images(paragraph: Paragraph, document: Document, page: int) -> list[dict]:
    """
    Extract every inline picture embedded in `paragraph` as best-effort
    "image" blocks carrying raw bytes (`_image_bytes`/`_image_ext`) for a
    later upload step (report_store._extract_and_upload_images) to turn
    into a Storage `image_url`. These two keys are an in-process-only
    carrier — never JSON-serialized, always stripped before a report is
    persisted or returned.

    python-docx exposes an inline picture as a `<w:drawing>` run child
    containing a `<pic:pic>` element whose `<a:blip r:embed="...">`
    attribute is the relationship id; `document.part.related_parts[rId]`
    resolves that id to the actual image part or raises KeyError for a
    dangling relationship (rare, but not fatal here).

    Never raises: any failure extracting one picture is logged and
    skipped, exactly like the rest of this module's "one bad element
    should never drop the whole document" posture — image extraction is
    additive and must never break text extraction.
    """
    blocks: list[dict] = []
    try:
        pics = paragraph._p.xpath(".//pic:pic")
    except Exception:
        logger.exception("Failed to look up inline pictures in a docx paragraph.")
        return blocks

    seen_rids: set[str] = set()
    for pic in pics:
        try:
            for blip in pic.xpath(".//a:blip"):
                rid = blip.get(qn("r:embed"))
                if not rid or rid in seen_rids:
                    continue
                seen_rids.add(rid)

                part = document.part.related_parts.get(rid)
                if part is None:
                    continue
                image_bytes = part.blob
                if not image_bytes:
                    continue

                ext = _IMAGE_EXT_BY_CONTENT_TYPE.get(part.content_type, "png")
                blocks.append({
                    "type": "image", "level": None, "list_type": None,
                    "text": "", "page": page,
                    "_image_bytes": image_bytes, "_image_ext": ext,
                })
        except Exception:
            logger.exception("Failed to extract an inline docx image; skipping it.")
            continue

    return blocks


def _table_block(table: Table, page: int) -> dict | None:
    rows = []
    for row in table.rows:
        cells = [clean_text(cell.text) for cell in row.cells]
        if any(cells):
            rows.append(cells)
    if not rows:
        return None
    return {
        "type": "table", "level": None, "list_type": None,
        # No literal "\n" here on purpose: document_model._split_paragraphs
        # treats ANY newline as a block boundary (not just blank-line "\n\n"
        # runs), so a table whose flattened text contained one would split
        # into extra spans and desync the 1:1 block<->span correspondence
        # build_document() relies on to attach type/level/page metadata —
        # silently losing structure for the entire section, not just this
        # block. Rows are still available structured in "rows" below; this
        # "text" is only the matching-pipeline's plain-text view of it.
        "text": " ¶ ".join(" | ".join(r) for r in rows),
        "page": page,
        "rows": rows,
    }


def extract_structured_sections_from_docx(docx_path: str) -> dict:
    """
    Returns {"title": str, "sections": {"body": [block, ...]}} — the same
    shape extractor.extract_structured_sections_from_pdf() returns, minus
    the academic section buckets (see module docstring for why).
    """
    document = Document(docx_path)
    numbering_defs = _numbering_definitions(document)
    list_counters: dict[str, dict[int, int]] = {}

    blocks: list[dict] = []
    title = ""
    page = 1
    blocks_on_page = 0

    for item in _iter_block_items(document):
        if isinstance(item, Table):
            list_counters.pop("__manual__", None)
            block = _table_block(item, page)
            if block:
                blocks.append(block)
                blocks_on_page += 1
            continue

        style_name = (item.style.name or "").lower() if item.style else ""
        if not title and style_name == "title":
            candidate = clean_text(item.text)
            if candidate:
                title = candidate
                continue

        block = _paragraph_block(item, page, numbering_defs, list_counters)
        if block:
            blocks.append(block)
            blocks_on_page += 1

        # Best-effort inline-image extraction. Runs regardless of whether
        # the paragraph also had text (a figure often sits alone in its
        # own paragraph, in which case `block` above is None) — appended
        # right after the paragraph's own text block so an image lands
        # next to whatever caption/text shares its paragraph, matching
        # document order closely enough for the Document view.
        try:
            image_blocks = _paragraph_images(item, document, page)
        except Exception:
            image_blocks = []
            logger.exception("Image extraction failed for a docx paragraph; continuing without its images.")
        if image_blocks:
            blocks.extend(image_blocks)
            blocks_on_page += len(image_blocks)

        if _has_hard_page_break(item):
            page += 1
            blocks_on_page = 0
        elif blocks_on_page >= BLOCKS_PER_SYNTHETIC_PAGE:
            page += 1
            blocks_on_page = 0

    if not title:
        for b in blocks:
            if b["type"] == "heading":
                title = b["text"]
                break

    return {
        "title": title,
        "sections": {FALLBACK_SECTION: blocks} if blocks else {},
    }
