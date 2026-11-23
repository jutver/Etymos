"""
pdf_export.py
-------------
Builds downloadable PDF exports for checked documents:
1. Original document export: preserves the original uploaded PDF verbatim
   (or renders clean pages from `input_text` when no original PDF exists).
2. Edited document export: performs paragraph/block-level diffing against the
   original document and surgically patches modified regions in-place using
   PyMuPDF redactions (`PDF_REDACT_IMAGE_NONE` so images/figures stay intact)
   and `insert_htmlbox`, with automatic vertical whitespace expansion, gentle
   font scaling, and continuation-page overflow protection so edited text never
   overlaps or clips. Falls back to structured HTML rendering via `pymupdf.Story`
   when no original PDF exists or edits are overwhelmingly rewritten.
3. Appended report pages: generates localized (English / Vietnamese) multi-page
   Similarity, AI Detection, Published Paper Match, and detailed Matched Sources
   report pages at the end of every exported PDF.
"""

from __future__ import annotations

import difflib
import html
import io
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Any, Literal

import pymupdf

A4_RECT = pymupdf.paper_rect("a4")
PAGE_MARGIN = 48.0

_BLOCK_TAGS = {"h1", "h2", "h3", "h4", "p", "li", "blockquote", "pre"}
_SKIP_TAGS = {"script", "style", "sup"}

_STRINGS: dict[str, dict[str, str]] = {
    "en": {
        "brand": "ETYMOS REPORT",
        "report_title": "Similarity & AI Detection Report",
        "document_label": "Document",
        "version_label": "Exported Version",
        "exported_at": "Exported At",
        "word_count": "Word Count",
        "similarity_score": "Similarity Score",
        "ai_score": "AI Writing Score",
        "ai_unavailable": "Not available",
        "not_rechecked_note": "Note: This edited version has not been re-checked yet; scores reflect the latest check.",
        "published_paper_title": "Published Paper Match Detected",
        "published_paper_body": "This document appears to match the published paper \"{title}\" ({percent}% overlap).",
        "source_summary": "Matched Sources Summary",
        "total_sources": "Total Matched Sources",
        "academic_sources": "Academic Papers",
        "web_sources": "Web Sources",
        "matched_sources_heading": "Detailed Matched Sources",
        "no_sources": "No matching sources were detected for this document.",
        "source_academic": "Academic Paper",
        "source_web": "Web Source",
        "match_percent": "{percent:.1f}% match",
        "authors": "Authors",
        "year": "Year",
        "venue": "Venue",
        "doi": "DOI",
        "url": "URL",
        "matched_passages": "Matched Passages ({count})",
        "submitted_excerpt": "Submitted text",
        "source_excerpt": "Matched source text",
        "reason": "Match reason",
        "continued_heading": "Edited Content Continuation",
        "original_version": "Original Document",
    },
    "vi": {
        "brand": "BÁO CÁO ETYMOS",
        "report_title": "Báo cáo Kiểm tra Tương đồng & Nội dung AI",
        "document_label": "Tài liệu",
        "version_label": "Phiên bản xuất",
        "exported_at": "Thời gian xuất",
        "word_count": "Số từ",
        "similarity_score": "Tỉ lệ Tương đồng",
        "ai_score": "Tỉ lệ Văn bản AI",
        "ai_unavailable": "Chưa khả dụng",
        "not_rechecked_note": "Lưu ý: Phiên bản đã chỉnh sửa này chưa được kiểm tra lại; điểm số phản ánh lần kiểm tra gần nhất.",
        "published_paper_title": "Phát hiện trùng khớp bài báo đã xuất bản",
        "published_paper_body": "Tài liệu này có vẻ trùng khớp với bài báo đã xuất bản \"{title}\" ({percent}% trùng khớp).",
        "source_summary": "Tổng quan Nguồn trùng khớp",
        "total_sources": "Tổng số nguồn trùng khớp",
        "academic_sources": "Bài báo khoa học",
        "web_sources": "Nguồn web",
        "matched_sources_heading": "Chi tiết các Nguồn trùng khớp",
        "no_sources": "Không phát hiện nguồn trùng khớp nào cho tài liệu này.",
        "source_academic": "Bài báo khoa học",
        "source_web": "Nguồn web",
        "match_percent": "{percent:.1f}% trùng khớp",
        "authors": "Tác giả",
        "year": "Năm",
        "venue": "Nơi công bố",
        "doi": "DOI",
        "url": "Liên kết",
        "matched_passages": "Các đoạn trùng khớp ({count})",
        "submitted_excerpt": "Đoạn trong tài liệu",
        "source_excerpt": "Đoạn từ nguồn",
        "reason": "Lý do đánh dấu",
        "continued_heading": "Nội dung chỉnh sửa tiếp theo",
        "original_version": "Tài liệu gốc",
    },
}


@dataclass
class ExportMatchedPassage:
    input_text: str
    source_text: str
    similarity: float
    reason: str = ""


@dataclass
class ExportMatchedSource:
    index: int
    source_kind: Literal["academic", "web"]
    title: str
    match_percent: float
    authors: list[str] = field(default_factory=list)
    year: int | None = None
    venue: str | None = None
    doi: str | None = None
    url: str | None = None
    pdf_url: str | None = None
    passages: list[ExportMatchedPassage] = field(default_factory=list)


@dataclass
class ReportExportContext:
    report_id: str
    title: str
    version_label: str
    version_kind: Literal["original", "saved", "draft"]
    exported_at: str
    lang: Literal["en", "vi"]
    word_count: int
    similarity_score: float
    ai_score: float | None
    ai_available: bool
    is_rechecked_estimate: bool
    published_paper_match: dict[str, Any] | None
    matched_sources: list[ExportMatchedSource]


class _EditorHtmlExtractor(HTMLParser):
    """Extracts clean paragraph blocks & sanitized HTML from editor markup."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._skip_depth = 0
        self._current_tag: str | None = None
        self._buf: list[str] = []
        self.blocks: list[dict[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag in _SKIP_TAGS:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if tag in _BLOCK_TAGS:
            self._flush()
            self._current_tag = tag
        elif tag == "br" and self._current_tag:
            self._buf.append("\n")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in _SKIP_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if self._skip_depth:
            return
        if tag in _BLOCK_TAGS:
            self._flush()
            self._current_tag = None

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        self._buf.append(data)

    def _flush(self) -> None:
        text = re.sub(r"[ \t]+", " ", "".join(self._buf)).strip()
        self._buf.clear()
        if text:
            self.blocks.append({"tag": self._current_tag or "p", "text": text})

    def finalize(self) -> list[dict[str, str]]:
        self._flush()
        return self.blocks


def html_to_structured_blocks(edited_html: str | None) -> list[dict[str, str]]:
    """Parse editor HTML into clean ordered text blocks, stripping match badges."""
    if not edited_html or not edited_html.strip():
        return []
    parser = _EditorHtmlExtractor()
    parser.feed(edited_html)
    parser.close()
    blocks = parser.finalize()
    if blocks:
        return blocks
    # Plain text fallback if HTML had no block tags
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in edited_html.splitlines()]
    return [{"tag": "p", "text": ln} for ln in lines if ln]


def _normalize_ws(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())


def _safe_float(val: Any, default: float = 0.0) -> float:
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


def _safe_int(val: Any) -> int | None:
    try:
        return int(val) if val is not None else None
    except (TypeError, ValueError):
        return None


def _extract_matched_sources(report: dict[str, Any]) -> list[ExportMatchedSource]:
    """Group matches under their source papers/web pages with full metadata."""
    matches_by_source: dict[str, list[ExportMatchedPassage]] = {}
    fallback_meta: dict[str, dict[str, Any]] = {}

    for m in report.get("matches") or []:
        sid = str(m.get("source_paper_id") or m.get("source_title") or "unknown")
        matches_by_source.setdefault(sid, []).append(
            ExportMatchedPassage(
                input_text=str(m.get("input_sentence") or "").strip(),
                source_text=str(m.get("source_sentence") or "").strip(),
                similarity=_safe_float(m.get("semantic_similarity"), 0.0),
                reason=str(m.get("reason") or m.get("explanation") or "").strip(),
            )
        )
        if sid not in fallback_meta:
            fallback_meta[sid] = {
                "title": m.get("source_title") or sid,
                "source_kind": "web" if m.get("source_kind") == "web" else "academic",
                "url": m.get("source_url") or m.get("url"),
                "doi": m.get("doi"),
                "year": m.get("year"),
                "authors": m.get("authors") or [],
            }

    sources: list[ExportMatchedSource] = []
    seen_ids: set[str] = set()
    papers = report.get("matched_papers") or []

    for idx, p in enumerate(papers, start=1):
        sid = str(p.get("source_paper_id") or p.get("source_title") or f"src-{idx}")
        seen_ids.add(sid)
        kind: Literal["academic", "web"] = "web" if p.get("source_kind") == "web" else "academic"
        pct = _safe_float(p.get("match_percent"))
        if pct <= 0.0:
            pct = _safe_float(p.get("max_similarity"), 0.0) * 100.0
        authors_raw = p.get("authors") or fallback_meta.get(sid, {}).get("authors") or []
        authors = [str(a) for a in authors_raw if a] if isinstance(authors_raw, list) else [str(authors_raw)]
        sources.append(
            ExportMatchedSource(
                index=idx,
                source_kind=kind,
                title=str(p.get("source_title") or p.get("title") or fallback_meta.get(sid, {}).get("title") or sid),
                match_percent=round(pct, 1),
                authors=authors,
                year=_safe_int(p.get("year") or fallback_meta.get(sid, {}).get("year")),
                venue=str(p.get("venue")).strip() if p.get("venue") else None,
                doi=str(p.get("doi") or fallback_meta.get(sid, {}).get("doi") or "").strip() or None,
                url=str(p.get("url") or fallback_meta.get(sid, {}).get("url") or "").strip() or None,
                pdf_url=str(p.get("pdf_url") or "").strip() or None,
                passages=matches_by_source.get(sid, []),
            )
        )

    for sid, passages in matches_by_source.items():
        if sid in seen_ids:
            continue
        meta = fallback_meta.get(sid, {})
        max_sim = max((ps.similarity for ps in passages), default=0.0) * 100.0
        sources.append(
            ExportMatchedSource(
                index=len(sources) + 1,
                source_kind="web" if meta.get("source_kind") == "web" else "academic",
                title=str(meta.get("title") or sid),
                match_percent=round(max_sim, 1),
                authors=[str(a) for a in meta.get("authors", []) if a],
                year=_safe_int(meta.get("year")),
                doi=str(meta.get("doi") or "").strip() or None,
                url=str(meta.get("url") or "").strip() or None,
                passages=passages,
            )
        )

    sources.sort(key=lambda s: s.match_percent, reverse=True)
    for i, src in enumerate(sources, start=1):
        src.index = i
    return sources


def build_export_context(
    *,
    report_id: str,
    title: str,
    report: dict[str, Any],
    version_kind: Literal["original", "saved", "draft"],
    version_label: str | None = None,
    edited_html: str | None = None,
    lang: Literal["en", "vi"] = "en",
    snapshot_scores: dict[str, Any] | None = None,
) -> ReportExportContext:
    """Assemble all report metadata, scores, and matched sources for export."""
    resolved_lang: Literal["en", "vi"] = "vi" if lang == "vi" else "en"
    strings = _STRINGS[resolved_lang]

    blocks = html_to_structured_blocks(edited_html) if version_kind != "original" else []
    body_text = (
        "\n\n".join(b["text"] for b in blocks)
        if blocks
        else str(report.get("input_text") or "")
    )
    word_count = len(body_text.split())

    sim_score = _safe_float(report.get("overall_score"), 0.0)
    ai_block = report.get("ai_detection") if isinstance(report.get("ai_detection"), dict) else {}
    ai_score: float | None = (
        _safe_float(ai_block.get("ai_score")) if ai_block.get("ai_score") is not None else None
    )
    ai_available = ai_score is not None
    is_estimate = False

    if version_kind in ("saved", "draft"):
        if snapshot_scores and snapshot_scores.get("checked"):
            if snapshot_scores.get("similarity_score") is not None:
                sim_score = _safe_float(snapshot_scores["similarity_score"], sim_score)
            if snapshot_scores.get("ai_score") is not None:
                ai_score = _safe_float(snapshot_scores["ai_score"])
                ai_available = True
        else:
            is_estimate = True

    resolved_label = (version_label or "").strip() or (
        strings["original_version"] if version_kind == "original" else "Edited Version"
    )
    exported_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    pub_match = report.get("published_paper_match")
    if not isinstance(pub_match, dict) or not pub_match.get("title"):
        pub_match = None

    return ReportExportContext(
        report_id=report_id,
        title=title or "Document",
        version_label=resolved_label,
        version_kind=version_kind,
        exported_at=exported_at,
        lang=resolved_lang,
        word_count=word_count,
        similarity_score=round(sim_score, 1),
        ai_score=round(ai_score, 1) if ai_score is not None else None,
        ai_available=ai_available,
        is_rechecked_estimate=is_estimate,
        published_paper_match=pub_match,
        matched_sources=_extract_matched_sources(report),
    )


def _render_html_to_pdf_doc(html_body: str, css: str, page_rect: pymupdf.Rect = A4_RECT) -> pymupdf.Document:
    """Render an HTML string into a multi-page PyMuPDF Document using Story."""
    story = pymupdf.Story(html=html_body, user_css=css)
    buf = io.BytesIO()
    writer = pymupdf.DocumentWriter(buf)
    mediabox = pymupdf.Rect(page_rect)
    where = pymupdf.Rect(
        PAGE_MARGIN,
        PAGE_MARGIN,
        mediabox.width - PAGE_MARGIN,
        mediabox.height - PAGE_MARGIN,
    )
    more = 1
    while more:
        dev = writer.begin_page(mediabox)
        more, _ = story.place(where)
        story.draw(dev)
        writer.end_page()
    writer.close()
    buf.seek(0)
    return pymupdf.open(stream=buf.read(), filetype="pdf")


def _render_blocks_to_pdf_doc(
    blocks: list[dict[str, str]],
    page_rect: pymupdf.Rect = A4_RECT,
) -> pymupdf.Document:
    """Render structured blocks (headings, paragraphs, list items) cleanly."""
    parts: list[str] = ["<div class='doc-body'>"]
    in_list = False
    for b in blocks:
        tag = b.get("tag", "p")
        txt = html.escape(b.get("text", "")).replace("\n", "<br/>")
        if tag == "li":
            if not in_list:
                parts.append("<ul>")
                in_list = True
            parts.append(f"<li>{txt}</li>")
        else:
            if in_list:
                parts.append("</ul>")
                in_list = False
            safe_tag = tag if tag in {"h1", "h2", "h3", "h4", "p", "blockquote", "pre"} else "p"
            parts.append(f"<{safe_tag}>{txt}</{safe_tag}>")
    if in_list:
        parts.append("</ul>")
    parts.append("</div>")

    css = """
    body { font-family: sans-serif; font-size: 10.5pt; line-height: 1.5; color: #111827; }
    h1 { font-size: 16pt; font-weight: bold; margin: 0 0 10pt 0; color: #0f172a; }
    h2 { font-size: 13pt; font-weight: bold; margin: 14pt 0 6pt 0; color: #0f172a; }
    h3, h4 { font-size: 11.5pt; font-weight: bold; margin: 10pt 0 4pt 0; color: #1e293b; }
    p { margin: 0 0 8pt 0; text-align: left; }
    ul { margin: 0 0 8pt 16pt; padding: 0; }
    li { margin: 0 0 4pt 0; }
    blockquote { border-left: 2pt solid #cbd5e1; padding-left: 8pt; color: #475569; margin: 6pt 0; }
    """
    return _render_html_to_pdf_doc("".join(parts), css, page_rect=page_rect)


def _extract_baseline_paragraphs(original_text: str) -> list[str]:
    paras = [re.sub(r"[ \t]+", " ", p).strip() for p in re.split(r"\n\s*\n", original_text or "")]
    paras = [p for p in paras if p]
    if len(paras) <= 1 and original_text:
        lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in original_text.splitlines()]
        paras = [ln for ln in lines if ln]
    return paras


def _diff_text_segments(
    original_paras: list[str],
    edited_paras: list[str],
) -> tuple[list[tuple[str, str]], list[str]]:
    """Return (replacements[(old, new)], pure_additions[new])."""
    norm_orig = [_normalize_ws(p) for p in original_paras]
    norm_edit = [_normalize_ws(p) for p in edited_paras]
    sm = difflib.SequenceMatcher(None, norm_orig, norm_edit)
    replacements: list[tuple[str, str]] = []
    additions: list[str] = []

    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        if tag == "replace":
            old_chunk = original_paras[i1:i2]
            new_chunk = edited_paras[j1:j2]
            pair_count = min(len(old_chunk), len(new_chunk))
            for k in range(pair_count):
                if _normalize_ws(old_chunk[k]) != _normalize_ws(new_chunk[k]):
                    replacements.append((old_chunk[k], new_chunk[k]))
            if len(old_chunk) > pair_count:
                for k in range(pair_count, len(old_chunk)):
                    replacements.append((old_chunk[k], ""))
            if len(new_chunk) > pair_count:
                # Attach extra paragraphs to the last replaced block if possible, else append
                extra = "\n\n".join(new_chunk[pair_count:])
                if replacements:
                    prev_old, prev_new = replacements[-1]
                    replacements[-1] = (prev_old, f"{prev_new}\n\n{extra}".strip())
                else:
                    additions.extend(new_chunk[pair_count:])
        elif tag == "delete":
            for k in range(i1, i2):
                replacements.append((original_paras[k], ""))
        elif tag == "insert":
            additions.extend(edited_paras[j1:j2])

    return replacements, additions


def _page_text_blocks(page: pymupdf.Page) -> list[dict[str, Any]]:
    """Extract text blocks with dominant font size, color, and bounding box.

    Splits lines that sit in separate horizontal columns (e.g. 2-column papers)
    so redacting one column never touches the adjacent column.
    """
    raw = page.get_text("dict")
    out: list[dict[str, Any]] = []
    for blk in raw.get("blocks", []):
        if blk.get("type") != 0:
            continue
        col_groups: list[list[dict[str, Any]]] = []
        for ln in blk.get("lines", []):
            lb = pymupdf.Rect(ln["bbox"])
            placed = False
            for grp in col_groups:
                gx0 = min(item["bbox"][0] for item in grp)
                gx1 = max(item["bbox"][2] for item in grp)
                # Same column if horizontal ranges overlap or are within 14pt
                if min(gx1, lb.x1) - max(gx0, lb.x0) >= -14.0:
                    grp.append(ln)
                    placed = True
                    break
            if not placed:
                col_groups.append([ln])

        for grp in col_groups:
            lines_text: list[str] = []
            sizes: list[float] = []
            colors: list[int] = []
            rect = pymupdf.Rect(grp[0]["bbox"])
            for ln in grp:
                rect |= pymupdf.Rect(ln["bbox"])
                spans_text = []
                for sp in ln.get("spans", []):
                    t = sp.get("text", "")
                    if t:
                        spans_text.append(t)
                        sizes.append(float(sp.get("size") or 10.5))
                        colors.append(int(sp.get("color") or 0))
                if spans_text:
                    lines_text.append("".join(spans_text))
            joined = _normalize_ws(" ".join(lines_text))
            if not joined:
                continue
            avg_size = sum(sizes) / len(sizes) if sizes else 10.5
            dom_color = colors[0] if colors else 0
            out.append(
                {
                    "rect": rect,
                    "text": joined,
                    "font_size": max(7.0, min(24.0, avg_size)),
                    "color": dom_color,
                }
            )
    return out


def _int_color_to_hex(color_int: int) -> str:
    r = (color_int >> 16) & 0xFF
    g = (color_int >> 8) & 0xFF
    b = color_int & 0xFF
    return f"#{r:02x}{g:02x}{b:02x}"


def _find_matching_block(
    pdf_doc: pymupdf.Document,
    old_text: str,
) -> tuple[int, dict[str, Any]] | None:
    """Locate the PDF page and block best matching `old_text`."""
    needle = _normalize_ws(old_text)
    if not needle:
        return None
    best_score = 0.0
    best_hit: tuple[int, dict[str, Any]] | None = None

    for p_idx in range(len(pdf_doc)):
        page = pdf_doc[p_idx]
        blocks = _page_text_blocks(page)
        for blk in blocks:
            hay = blk["text"]
            if needle in hay or hay in needle:
                ratio = min(len(needle), len(hay)) / max(len(needle), len(hay), 1)
                score = 0.75 + 0.25 * ratio
            else:
                score = difflib.SequenceMatcher(None, needle[:400], hay[:400]).ratio()
            if score > best_score:
                best_score = score
                best_hit = (p_idx, blk)

    if best_hit and best_score >= 0.62:
        return best_hit
    return None


def _available_right_x(
    page: pymupdf.Page,
    target_rect: pymupdf.Rect,
    all_blocks: list[dict[str, Any]],
) -> float:
    """Expand short-line block width up to the column/page right margin without overlapping adjacent columns."""
    limit = page.rect.width - PAGE_MARGIN
    for blk in all_blocks:
        r: pymupdf.Rect = blk["rect"]
        if r == target_rect:
            continue
        vert_overlap = min(r.y1, target_rect.y1) - max(r.y0, target_rect.y0)
        if vert_overlap > 4.0 and r.x0 >= target_rect.x1 - 2.0:
            limit = min(limit, r.x0 - 8.0)
    return max(target_rect.x1, limit)


def _available_bottom_y(
    page: pymupdf.Page,
    target_rect: pymupdf.Rect,
    all_blocks: list[dict[str, Any]],
) -> float:
    """Find the lowest Y coordinate below `target_rect` before colliding with another block in the same column."""
    limit = page.rect.height - PAGE_MARGIN
    for blk in all_blocks:
        r: pymupdf.Rect = blk["rect"]
        if r == target_rect:
            continue
        # Check horizontal column overlap
        horiz_overlap = min(r.x1, target_rect.x1) - max(r.x0, target_rect.x0)
        if horiz_overlap > 6.0 and r.y0 >= target_rect.y1 - 2.0:
            limit = min(limit, r.y0 - 4.0)
    return max(target_rect.y1, limit)


def _measure_story_height(html_fragment: str, css: str, width: float) -> float:
    """Measure height required to render `html_fragment` at `width`."""
    story = pymupdf.Story(html=html_fragment, user_css=css)
    where = pymupdf.Rect(0, 0, max(40.0, width), 10000.0)
    _, filled = story.place(where)
    return float(filled[3])


def _patch_pdf_with_edits(
    original_pdf_bytes: bytes,
    original_text: str,
    edited_blocks: list[dict[str, str]],
    lang: Literal["en", "vi"],
) -> pymupdf.Document:
    """
    Surgically patch modified paragraphs in-place on the original PDF,
    preserving untouched layout, figures, tables, and page geometry.
    """
    doc = pymupdf.open(stream=original_pdf_bytes, filetype="pdf")
    if len(doc) == 0:
        return _render_blocks_to_pdf_doc(edited_blocks)

    edited_paras = [b["text"] for b in edited_blocks]
    orig_paras = _extract_baseline_paragraphs(original_text)
    if not orig_paras:
        orig_paras = [blk["text"] for p in range(len(doc)) for blk in _page_text_blocks(doc[p])]

    replacements, additions = _diff_text_segments(orig_paras, edited_paras)
    if not replacements and not additions:
        return doc

    anchored: list[tuple[int, dict[str, Any], str]] = []
    unanchored: list[str] = []
    for old_t, new_t in replacements:
        hit = _find_matching_block(doc, old_t)
        if hit is None:
            if new_t:
                unanchored.append(new_t)
        else:
            anchored.append((hit[0], hit[1], new_t))

    # If overwhelming rewrite (>70% of replacements couldn't be anchored),
    # fall back to clean structured reconstruction matching the first page's size.
    total_changes = len(replacements)
    if total_changes > 0 and len(unanchored) / total_changes > 0.70:
        return _render_blocks_to_pdf_doc(edited_blocks, page_rect=doc[0].rect)

    overflow_by_page: dict[int, list[str]] = {}

    # Apply redactions per page, then insert replacement text
    by_page: dict[int, list[tuple[dict[str, Any], str]]] = {}
    for p_idx, blk, new_t in anchored:
        by_page.setdefault(p_idx, []).append((blk, new_t))

    for p_idx, items in by_page.items():
        page = doc[p_idx]
        all_blocks = _page_text_blocks(page)
        for blk, _ in items:
            redact_rect = pymupdf.Rect(blk["rect"]) + (-1, -1, 1, 1)
            page.add_redact_annot(redact_rect, fill=(1, 1, 1))
        page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE)

        for blk, new_t in items:
            if not new_t.strip():
                continue
            rect = pymupdf.Rect(blk["rect"])
            font_size = blk["font_size"]
            color_hex = _int_color_to_hex(blk["color"])
            max_x = _available_right_x(page, rect, all_blocks)
            max_y = _available_bottom_y(page, rect, all_blocks)
            expanded_rect = pymupdf.Rect(rect.x0, rect.y0, max_x, max_y)

            safe_html = f"<p>{html.escape(new_t).replace(chr(10), '<br/>')}</p>"
            placed = False
            for scale in (1.0, 0.92, 0.85):
                sz = round(font_size * scale, 2)
                css = f"p {{ font-family: sans-serif; font-size: {sz}pt; line-height: 1.32; color: {color_hex}; margin: 0; }}"
                needed_h = _measure_story_height(safe_html, css, expanded_rect.width)
                if needed_h <= expanded_rect.height + 1.0:
                    page.insert_htmlbox(expanded_rect, safe_html, css=css)
                    placed = True
                    break

            if not placed:
                # Fit what we can cleanly without clipping, and spill the rest to a continuation page
                sz = round(font_size * 0.90, 2)
                css = f"p {{ font-family: sans-serif; font-size: {sz}pt; line-height: 1.32; color: {color_hex}; margin: 0; }}"
                words = new_t.split()
                fit_idx = len(words)
                while fit_idx > 1:
                    candidate = " ".join(words[:fit_idx]) + " …"
                    cand_html = f"<p>{html.escape(candidate)}</p>"
                    if _measure_story_height(cand_html, css, expanded_rect.width) <= expanded_rect.height:
                        page.insert_htmlbox(expanded_rect, cand_html, css=css)
                        overflow_by_page.setdefault(p_idx, []).append(" ".join(words[fit_idx:]))
                        break
                    fit_idx = max(1, int(fit_idx * 0.8))
                else:
                    overflow_by_page.setdefault(p_idx, []).append(new_t)

    # Insert continuation pages right after overflowing pages (in reverse index order)
    strings = _STRINGS[lang]
    for p_idx in sorted(overflow_by_page.keys(), reverse=True):
        cont_blocks = [{"tag": "h3", "text": strings["continued_heading"]}]
        for txt in overflow_by_page[p_idx]:
            cont_blocks.append({"tag": "p", "text": txt})
        cont_doc = _render_blocks_to_pdf_doc(cont_blocks, page_rect=doc[p_idx].rect)
        doc.insert_pdf(cont_doc, start_at=p_idx + 1)

    extra_tail = unanchored + additions
    if extra_tail:
        tail_blocks = [{"tag": "p", "text": t} for t in extra_tail if t.strip()]
        if tail_blocks:
            tail_doc = _render_blocks_to_pdf_doc(tail_blocks, page_rect=doc[-1].rect)
            doc.insert_pdf(tail_doc)

    return doc


def render_report_appendix_pdf(context: ReportExportContext) -> pymupdf.Document:
    """Render localized Similarity, AI, Published Paper & Matched Sources pages."""
    s = _STRINGS[context.lang]
    ai_display = f"{context.ai_score:.1f}%" if context.ai_available and context.ai_score is not None else s["ai_unavailable"]
    academic_count = sum(1 for src in context.matched_sources if src.source_kind == "academic")
    web_count = sum(1 for src in context.matched_sources if src.source_kind == "web")

    parts: list[str] = [
        f"<div class='header'><div class='brand'>{html.escape(s['brand'])}</div>"
        f"<h1>{html.escape(s['report_title'])}</h1></div>",
        "<table class='meta-table'>",
        f"<tr><td class='lbl'>{html.escape(s['document_label'])}</td><td>{html.escape(context.title)}</td></tr>",
        f"<tr><td class='lbl'>{html.escape(s['version_label'])}</td><td>{html.escape(context.version_label)}</td></tr>",
        f"<tr><td class='lbl'>{html.escape(s['exported_at'])}</td><td>{html.escape(context.exported_at)}</td></tr>",
        f"<tr><td class='lbl'>{html.escape(s['word_count'])}</td><td>{context.word_count:,}</td></tr>",
        "</table>",
        "<table class='score-grid'><tr>",
        f"<td class='score-card sim'><div class='sc-label'>{html.escape(s['similarity_score'])}</div>"
        f"<div class='sc-val'>{context.similarity_score:.1f}%</div></td>",
        f"<td class='score-card ai'><div class='sc-label'>{html.escape(s['ai_score'])}</div>"
        f"<div class='sc-val'>{html.escape(ai_display)}</div></td>",
        "</tr></table>",
    ]

    if context.is_rechecked_estimate:
        parts.append(f"<div class='notice warn'>{html.escape(s['not_rechecked_note'])}</div>")

    if context.published_paper_match:
        pub_title = str(context.published_paper_match.get("title") or "")
        pub_pct = _safe_float(context.published_paper_match.get("match_percent"), context.similarity_score)
        pub_msg = s["published_paper_body"].format(title=pub_title, percent=f"{pub_pct:.1f}")
        parts.append(
            f"<div class='notice info'><strong>{html.escape(s['published_paper_title'])}</strong><br/>"
            f"{html.escape(pub_msg)}</div>"
        )

    parts.append(
        f"<h2>{html.escape(s['source_summary'])}</h2>"
        "<table class='meta-table'>"
        f"<tr><td class='lbl'>{html.escape(s['total_sources'])}</td><td>{len(context.matched_sources)}</td></tr>"
        f"<tr><td class='lbl'>{html.escape(s['academic_sources'])}</td><td>{academic_count}</td></tr>"
        f"<tr><td class='lbl'>{html.escape(s['web_sources'])}</td><td>{web_count}</td></tr>"
        "</table>"
    )

    parts.append(f"<h2>{html.escape(s['matched_sources_heading'])}</h2>")
    if not context.matched_sources:
        parts.append(f"<p class='empty'>{html.escape(s['no_sources'])}</p>")
    else:
        for src in context.matched_sources:
            kind_label = s["source_academic"] if src.source_kind == "academic" else s["source_web"]
            pct_label = s["match_percent"].format(percent=src.match_percent)
            parts.append("<div class='source-card'>")
            parts.append(
                f"<div class='src-head'><span class='badge'>#{src.index}</span> "
                f"<span class='kind'>{html.escape(kind_label)}</span> · "
                f"<span class='pct'>{html.escape(pct_label)}</span></div>"
            )
            parts.append(f"<div class='src-title'>{html.escape(src.title)}</div>")

            meta_rows: list[str] = []
            if src.authors:
                meta_rows.append(f"<strong>{html.escape(s['authors'])}:</strong> {html.escape(', '.join(src.authors[:8]))}")
            if src.year:
                meta_rows.append(f"<strong>{html.escape(s['year'])}:</strong> {src.year}")
            if src.venue:
                meta_rows.append(f"<strong>{html.escape(s['venue'])}:</strong> {html.escape(src.venue)}")
            if src.doi:
                meta_rows.append(f"<strong>{html.escape(s['doi'])}:</strong> {html.escape(src.doi)}")
            if src.url:
                meta_rows.append(f"<strong>{html.escape(s['url'])}:</strong> {html.escape(src.url)}")
            if meta_rows:
                parts.append(f"<div class='src-meta'>{'<br/>'.join(meta_rows)}</div>")

            if src.passages:
                parts.append(
                    f"<div class='passages-hdr'>{html.escape(s['matched_passages'].format(count=len(src.passages)))}</div>"
                )
                for ps in src.passages:
                    parts.append("<div class='passage-box'>")
                    if ps.input_text:
                        parts.append(
                            f"<div class='ps-lbl'>{html.escape(s['submitted_excerpt'])} ({ps.similarity * 100:.1f}%):</div>"
                            f"<div class='ps-txt'>{html.escape(ps.input_text)}</div>"
                        )
                    if ps.source_text and ps.source_text != ps.input_text:
                        parts.append(
                            f"<div class='ps-lbl'>{html.escape(s['source_excerpt'])}:</div>"
                            f"<div class='ps-txt muted'>{html.escape(ps.source_text)}</div>"
                        )
                    if ps.reason:
                        parts.append(
                            f"<div class='ps-reason'><strong>{html.escape(s['reason'])}:</strong> {html.escape(ps.reason)}</div>"
                        )
                    parts.append("</div>")
            parts.append("</div>")

    css = """
    body { font-family: sans-serif; font-size: 9.5pt; line-height: 1.42; color: #1e293b; }
    .header { border-bottom: 2pt solid #1e3a8a; padding-bottom: 8pt; margin-bottom: 12pt; }
    .brand { font-size: 8.5pt; font-weight: bold; letter-spacing: 1pt; color: #2563eb; }
    h1 { font-size: 16pt; margin: 2pt 0 0 0; color: #0f172a; }
    h2 { font-size: 12pt; margin: 14pt 0 6pt 0; color: #0f172a; border-bottom: 0.75pt solid #e2e8f0; padding-bottom: 3pt; }
    .meta-table { width: 100%; border-collapse: collapse; margin-bottom: 10pt; }
    .meta-table td { padding: 4pt 6pt; border-bottom: 0.5pt solid #e2e8f0; vertical-align: top; }
    .meta-table td.lbl { width: 140pt; font-weight: bold; color: #475569; }
    .score-grid { width: 100%; border-collapse: separate; border-spacing: 8pt 0; margin: 8pt -8pt 10pt -8pt; }
    .score-card { width: 50%; padding: 10pt 12pt; border: 1pt solid #cbd5e1; border-radius: 4pt; background-color: #f8fafc; }
    .score-card.sim { border-left: 3pt solid #dc2626; }
    .score-card.ai { border-left: 3pt solid #7c3aed; }
    .sc-label { font-size: 8.5pt; color: #475569; font-weight: bold; }
    .sc-val { font-size: 18pt; font-weight: bold; color: #0f172a; margin-top: 2pt; }
    .notice { padding: 8pt 10pt; border-radius: 4pt; margin: 8pt 0; font-size: 9pt; }
    .notice.warn { background-color: #fffbeb; border: 0.75pt solid #f59e0b; color: #92400e; }
    .notice.info { background-color: #eff6ff; border: 0.75pt solid #3b82f6; color: #1e3a8a; }
    .source-card { border: 0.75pt solid #cbd5e1; border-radius: 4pt; padding: 8pt 10pt; margin-bottom: 10pt; background-color: #ffffff; break-inside: avoid; }
    .src-head { font-size: 8.5pt; color: #475569; margin-bottom: 3pt; }
    .badge { font-weight: bold; color: #1d4ed8; }
    .pct { font-weight: bold; color: #b91c1c; }
    .src-title { font-size: 10.5pt; font-weight: bold; color: #0f172a; margin-bottom: 4pt; }
    .src-meta { font-size: 8.5pt; color: #334155; margin-bottom: 6pt; line-height: 1.35; }
    .passages-hdr { font-size: 8.5pt; font-weight: bold; color: #475569; margin: 4pt 0 3pt 0; }
    .passage-box { border-left: 2pt solid #94a3b8; padding-left: 7pt; margin: 4pt 0 6pt 0; font-size: 8.75pt; }
    .ps-lbl { font-weight: bold; color: #334155; font-size: 8pt; }
    .ps-txt { color: #0f172a; margin-bottom: 2pt; }
    .ps-txt.muted { color: #475569; }
    .ps-reason { font-size: 8.25pt; color: #1e40af; margin-top: 2pt; }
    .empty { color: #64748b; font-style: italic; }
    """
    return _render_html_to_pdf_doc("".join(parts), css, page_rect=A4_RECT)


def generate_export_pdf(
    *,
    context: ReportExportContext,
    original_pdf_bytes: bytes | None,
    original_text: str,
    edited_html: str | None = None,
) -> bytes:
    """Build the complete exported PDF (document body + appended report pages)."""
    if context.version_kind == "original":
        if original_pdf_bytes:
            body_doc = pymupdf.open(stream=original_pdf_bytes, filetype="pdf")
        else:
            blocks = [{"tag": "p", "text": p} for p in _extract_baseline_paragraphs(original_text)]
            body_doc = _render_blocks_to_pdf_doc(blocks or [{"tag": "p", "text": ""}])
    else:
        edited_blocks = html_to_structured_blocks(edited_html)
        if not edited_blocks:
            edited_blocks = [{"tag": "p", "text": p} for p in _extract_baseline_paragraphs(original_text)]
        if original_pdf_bytes:
            body_doc = _patch_pdf_with_edits(
                original_pdf_bytes=original_pdf_bytes,
                original_text=original_text,
                edited_blocks=edited_blocks,
                lang=context.lang,
            )
        else:
            body_doc = _render_blocks_to_pdf_doc(edited_blocks)

    appendix_doc = render_report_appendix_pdf(context)
    body_doc.insert_pdf(appendix_doc)
    out_bytes = body_doc.tobytes(garbage=4, deflate=True)
    appendix_doc.close()
    body_doc.close()
    return out_bytes
