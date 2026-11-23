"""
pdf_export.py
-------------
Builds downloadable PDF exports for checked documents:
1. Original document export: preserves the original uploaded PDF verbatim
   (or renders clean pages from `input_text` when no original PDF exists) and
   overlays translucent color-coded similarity match highlights keyed to each
   source's identity color.
2. Edited document export: performs paragraph/block-level diffing against the
   original document and surgically patches modified regions in-place using
   PyMuPDF redactions (`PDF_REDACT_IMAGE_NONE` so images/figures stay intact)
   and `insert_htmlbox` with unified Vietnamese/English typography, automatic
   vertical whitespace expansion, gentle font scaling, continuation pages, and
   highlights restricted to still-matching passages.
3. Appended report pages: generates localized (English / Vietnamese) multi-page
   Similarity, AI Detection, Published Paper Match, and compact color-matched
   Matched Sources report pages rendered in a single consistent typeface
   (Be Vietnam Pro) without verbose "why flagged" explanation dumps.
"""

from __future__ import annotations

import difflib
import functools
import html
import io
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Literal

import pymupdf

from search_paper.paper_identity import (
    canonical_paper_keys,
    classify_source_kind,
    strip_preprint_prefix,
)

A4_RECT = pymupdf.paper_rect("a4")
PAGE_MARGIN = 48.0
_FONTS_DIR = Path(__file__).resolve().parent / "assets" / "fonts"

_BLOCK_TAGS = {"h1", "h2", "h3", "h4", "p", "li", "blockquote", "pre"}
_SKIP_TAGS = {"script", "style", "sup"}


def _hex_to_rgb(hex_color: str) -> tuple[float, float, float]:
    h = hex_color.lstrip("#")
    return (
        int(h[0:2], 16) / 255.0,
        int(h[2:4], 16) / 255.0,
        int(h[4:6], 16) / 255.0,
    )


@dataclass(frozen=True)
class SourceColorToken:
    """Identity color pairing document highlights with appended source cards."""

    key: str
    badge_hex: str
    accent_hex: str
    soft_bg_hex: str
    fill_rgb: tuple[float, float, float]
    fill_opacity: float
    accent_rgb: tuple[float, float, float]


SOURCE_PALETTE: tuple[SourceColorToken, ...] = (
    SourceColorToken(
        key="amber",
        badge_hex="#eab308",
        accent_hex="#d97706",
        soft_bg_hex="#fef8e2",
        fill_rgb=_hex_to_rgb("#eab308"),
        fill_opacity=0.16,
        accent_rgb=_hex_to_rgb("#d97706"),
    ),
    SourceColorToken(
        key="rose",
        badge_hex="#e11d48",
        accent_hex="#e11d48",
        soft_bg_hex="#fef0f2",
        fill_rgb=_hex_to_rgb("#e11d48"),
        fill_opacity=0.13,
        accent_rgb=_hex_to_rgb("#e11d48"),
    ),
    SourceColorToken(
        key="violet",
        badge_hex="#7c3aed",
        accent_hex="#7c3aed",
        soft_bg_hex="#f4f0fe",
        fill_rgb=_hex_to_rgb("#7c3aed"),
        fill_opacity=0.13,
        accent_rgb=_hex_to_rgb("#7c3aed"),
    ),
    SourceColorToken(
        key="teal",
        badge_hex="#0d9488",
        accent_hex="#0d9488",
        soft_bg_hex="#e6faf5",
        fill_rgb=_hex_to_rgb("#0d9488"),
        fill_opacity=0.13,
        accent_rgb=_hex_to_rgb("#0d9488"),
    ),
    SourceColorToken(
        key="sky",
        badge_hex="#2563eb",
        accent_hex="#2563eb",
        soft_bg_hex="#ebf3ff",
        fill_rgb=_hex_to_rgb("#2563eb"),
        fill_opacity=0.13,
        accent_rgb=_hex_to_rgb("#2563eb"),
    ),
    SourceColorToken(
        key="lime",
        badge_hex="#65a30d",
        accent_hex="#65a30d",
        soft_bg_hex="#f2fae3",
        fill_rgb=_hex_to_rgb("#65a30d"),
        fill_opacity=0.14,
        accent_rgb=_hex_to_rgb("#65a30d"),
    ),
)

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
        "ai_level_low": "Mostly human-written",
        "ai_level_possible": "Possibly AI-assisted",
        "ai_level_likely": "Likely AI-written",
        "ai_level_inconclusive": "Not enough evidence to judge",
        "not_rechecked_note": "Note: This edited version has not been re-checked yet; scores reflect the latest check.",
        "published_paper_title": "Published Paper Match Detected",
        "published_paper_body": "This document appears to match the published paper \"{title}\" ({percent}% overlap).",
        "source_breakdown": "{total} sources · {academic} academic · {web} web",
        "matched_sources_heading": "Matched Sources",
        "sources_legend": "Each color matches the highlighted passages in the document above.",
        "no_sources": "No matching sources were detected for this document.",
        "source_academic": "Academic Paper",
        "source_web": "Web Source",
        "passage_count_one": "{count} matched passage",
        "passage_count_many": "{count} matched passages",
        "authors": "Authors",
        "year": "Year",
        "venue": "Venue",
        "doi": "DOI",
        "url": "URL",
        "continued_heading": "Edited Content Continuation",
        "original_version": "Original Document",
        "current_draft": "Current Draft",
        "edited_version": "Edited Version",
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
        "ai_level_low": "Chủ yếu do người viết",
        "ai_level_possible": "Có thể có hỗ trợ AI",
        "ai_level_likely": "Khả năng cao do AI tạo",
        "ai_level_inconclusive": "Không đủ dữ liệu để kết luận",
        "not_rechecked_note": "Lưu ý: Phiên bản đã chỉnh sửa này chưa được kiểm tra lại; điểm số phản ánh lần kiểm tra gần nhất.",
        "published_paper_title": "Phát hiện trùng khớp bài báo đã xuất bản",
        "published_paper_body": "Tài liệu này có vẻ trùng khớp với bài báo đã xuất bản \"{title}\" ({percent}% trùng khớp).",
        "source_breakdown": "{total} nguồn · {academic} bài báo khoa học · {web} nguồn web",
        "matched_sources_heading": "Các Nguồn trùng khớp",
        "sources_legend": "Mỗi màu tương ứng với các đoạn được tô sáng trong tài liệu phía trên.",
        "no_sources": "Không phát hiện nguồn trùng khớp nào cho tài liệu này.",
        "source_academic": "Bài báo khoa học",
        "source_web": "Nguồn web",
        "passage_count_one": "{count} đoạn trùng khớp",
        "passage_count_many": "{count} đoạn trùng khớp",
        "authors": "Tác giả",
        "year": "Năm",
        "venue": "Nơi công bố",
        "doi": "DOI",
        "url": "Liên kết",
        "continued_heading": "Nội dung chỉnh sửa tiếp theo",
        "original_version": "Tài liệu gốc",
        "current_draft": "Bản nháp hiện tại",
        "edited_version": "Phiên bản đã chỉnh sửa",
    },
}


@functools.lru_cache(maxsize=1)
def _get_font_spec() -> tuple[str | None, str]:
    """Locate bundled Be Vietnam Pro TrueType fonts (or OS fallbacks) and build @font-face CSS."""
    candidates: list[tuple[Path, dict[str, tuple[str, int, str]]]] = [
        (
            _FONTS_DIR,
            {
                "BeVietnamPro-Regular.ttf": ("regular", 400, "normal"),
                "BeVietnamPro-Medium.ttf": ("medium", 500, "normal"),
                "BeVietnamPro-SemiBold.ttf": ("semibold", 600, "normal"),
                "BeVietnamPro-Bold.ttf": ("bold", 700, "normal"),
                "BeVietnamPro-Italic.ttf": ("italic", 400, "italic"),
            },
        ),
        (
            Path("/System/Library/Fonts/Supplemental"),
            {
                "Arial.ttf": ("regular", 400, "normal"),
                "Arial Bold.ttf": ("bold", 700, "normal"),
                "Arial Italic.ttf": ("italic", 400, "italic"),
            },
        ),
        (
            Path("/usr/share/fonts/truetype/noto"),
            {
                "NotoSans-Regular.ttf": ("regular", 400, "normal"),
                "NotoSans-Bold.ttf": ("bold", 700, "normal"),
            },
        ),
        (
            Path("/usr/share/fonts/truetype/dejavu"),
            {
                "DejaVuSans.ttf": ("regular", 400, "normal"),
                "DejaVuSans-Bold.ttf": ("bold", 700, "normal"),
            },
        ),
        (
            Path("/usr/share/fonts/truetype/liberation"),
            {
                "LiberationSans-Regular.ttf": ("regular", 400, "normal"),
                "LiberationSans-Bold.ttf": ("bold", 700, "normal"),
            },
        ),
    ]

    for font_dir, file_map in candidates:
        if not font_dir.is_dir():
            continue
        rules: list[str] = []
        has_regular = False
        has_bold = False
        for filename, (role, weight, style) in file_map.items():
            if (font_dir / filename).is_file():
                rules.append(
                    f'@font-face {{ font-family: "EtymosSans"; src: url("{filename}"); '
                    f"font-weight: {weight}; font-style: {style}; }}"
                )
                if role == "regular":
                    has_regular = True
                elif role == "bold":
                    has_bold = True
        if has_regular:
            if not has_bold:
                reg_file = next(fn for fn, (role, _, _) in file_map.items() if role == "regular")
                rules.append(
                    f'@font-face {{ font-family: "EtymosSans"; src: url("{reg_file}"); '
                    "font-weight: 700; font-style: normal; }"
                )
            rules.append(
                'body, div, span, p, a, li, td, th, h1, h2, h3, h4, strong, b, em { font-family: "EtymosSans", sans-serif; }'
            )
            return str(font_dir), "\n".join(rules)

    return None, ""


def _open_font_archive() -> tuple[pymupdf.Archive | None, str]:
    font_dir, font_css = _get_font_spec()
    if not font_dir:
        return None, ""
    return pymupdf.Archive(font_dir), font_css


@dataclass
class ExportHighlightMatch:
    source_index: int
    color: SourceColorToken
    snippet: str
    match_percent: float
    pdf_rects: list[dict[str, float]] = field(default_factory=list)
    start_offset: int | None = None
    end_offset: int | None = None


@dataclass
class ExportMatchedSource:
    index: int
    color: SourceColorToken
    source_kind: Literal["academic", "web"]
    title: str
    match_percent: float
    match_count: int = 0
    authors: list[str] = field(default_factory=list)
    year: int | None = None
    venue: str | None = None
    doi: str | None = None
    url: str | None = None


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
    ai_level: Literal["low", "possible", "likely"] | None = None
    ai_inconclusive: bool = False
    is_rechecked_estimate: bool = False
    published_paper_match: dict[str, Any] | None = None
    matched_sources: list[ExportMatchedSource] = field(default_factory=list)
    highlight_matches: list[ExportHighlightMatch] = field(default_factory=list)


class _EditorHtmlExtractor(HTMLParser):
    """Extracts clean paragraph blocks & sanitized text from editor markup."""

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
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in edited_html.splitlines()]
    return [{"tag": "p", "text": ln} for ln in lines if ln]


def _normalize_ws(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())


def _safe_float(val: Any, default: float = 0.0) -> float:
    try:
        return float(val) if val is not None else default
    except (TypeError, ValueError):
        return default


def _safe_int(val: Any) -> int | None:
    try:
        if val is None or val == "":
            return None
        return int(float(val))
    except (TypeError, ValueError):
        return None


def _parse_authors(raw: Any) -> list[str]:
    if not raw:
        return []
    if isinstance(raw, list):
        items = [str(a).strip() for a in raw if str(a).strip()]
    else:
        items = [part.strip() for part in str(raw).split(",") if part.strip()]
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        key = item.lower()
        if key not in seen:
            seen.add(key)
            out.append(item)
    return out


def _sanitize_source_title(raw_title: str, *, is_academic: bool = False) -> str:
    """Clean concatenated multi-result titles and preprint tags into one readable title."""
    cleaned = _normalize_ws(raw_title)
    if not cleaned:
        return ""
    if is_academic:
        cleaned = strip_preprint_prefix(cleaned) or cleaned
    cleaned = re.sub(r"^(?:\(\s*PDF\s*\)\s*)+", "", cleaned, flags=re.IGNORECASE).strip()

    has_concat_markers = bool(
        re.search(r"(?:\.\.\.|…)\s*\S|\(\s*PDF\s*\)\s+|\s*·\s*Hugging Face", cleaned, re.IGNORECASE)
    )
    if has_concat_markers:
        parts = re.split(
            r"(?:\.\.\.|…)\s*|(?<=\S)\s*(?=\(\s*PDF\s*\)\s+)",
            cleaned,
            flags=re.IGNORECASE,
        )
        candidates: list[str] = []
        for part in parts:
            piece = re.sub(r"^(?:\(\s*PDF\s*\)\s*)+", "", part, flags=re.IGNORECASE).strip(" ·-")
            if is_academic:
                piece = strip_preprint_prefix(piece) or piece
            if not piece:
                continue
            # Split off mirror site names glued to the next title (e.g. "· Hugging FaceViHateT5 - ...")
            sub_pieces = re.split(r"\b(?:Hugging Face|GitHub|ResearchGate)\s*(?=[A-Z0-9])", piece)
            for sub in sub_pieces:
                sub_clean = sub.strip(" ·-")
                if len(sub_clean) >= 6:
                    candidates.append(sub_clean)

        if candidates:
            head_prefix = re.sub(r"[^a-z0-9]+", " ", candidates[0].lower()).strip()[:20]
            non_mirror = [
                c for c in candidates
                if not re.search(r"(?:^|\s)[\w\-]+/[\w\-]+|\b(?:Hugging Face|GitHub)\b", c, re.IGNORECASE)
            ]
            pool = non_mirror or candidates
            matching_head = [
                c for c in pool
                if head_prefix and re.sub(r"[^a-z0-9]+", " ", c.lower()).strip().startswith(head_prefix[:14])
            ]
            if matching_head:
                # Prefer clean complete title or longest distinct prefix variant
                complete = [
                    c for c in matching_head
                    if not re.search(r"\b(?:a|an|the|in|on|of|for|with|and|to)$", c, re.IGNORECASE)
                ]
                cleaned = max(complete or matching_head, key=len)
            else:
                cleaned = max(pool, key=len)
    else:
        # Guard against direct glued repetition of the leading phrase without ellipsis
        probe = cleaned[:24].lower()
        if len(probe) >= 20:
            second = cleaned.lower().find(probe, 20)
            if second > 0:
                cleaned = cleaned[:second].strip(" ·-")

    if len(cleaned) > 160:
        cut = cleaned[:159].rsplit(" ", 1)[0].strip() or cleaned[:159]
        cleaned = f"{cut}…"
    return cleaned


def _valid_pdf_rects(raw_rects: Any) -> list[dict[str, float]]:
    if not isinstance(raw_rects, list):
        return []
    out: list[dict[str, float]] = []
    for item in raw_rects:
        if not isinstance(item, dict):
            continue
        try:
            page = int(item["page"])
            x0 = float(item["x0"])
            y0 = float(item["y0"])
            x1 = float(item["x1"])
            y1 = float(item["y1"])
        except (KeyError, TypeError, ValueError):
            continue
        if page >= 1 and x1 > x0 and y1 > y0:
            out.append({"page": page, "x0": x0, "y0": y0, "x1": x1, "y1": y1})
    return out


def _canonical_bucket_id(record: dict[str, Any], key_to_bucket: dict[str, str]) -> str:
    keys = canonical_paper_keys(record)
    title_hint = _sanitize_source_title(
        str(record.get("source_title") or record.get("title") or ""),
        is_academic=record.get("source_kind") == "academic",
    )
    if title_hint:
        norm_title = re.sub(r"[^a-z0-9]+", " ", title_hint.lower()).strip()
        if len(norm_title) >= 16:
            keys.append(f"clean_title:{norm_title}")
    fallback = str(record.get("source_paper_id") or title_hint or "unknown")
    if fallback:
        keys.append(f"id:{fallback}")
    bucket = next((key_to_bucket[k] for k in keys if k in key_to_bucket), None)
    if bucket is None:
        bucket = keys[0] if keys else fallback
    for k in keys:
        key_to_bucket.setdefault(k, bucket)
    return bucket


def _merge_intervals(intervals: list[tuple[int, int]]) -> int:
    if not intervals:
        return 0
    sorted_iv = sorted((s, e) for s, e in intervals if e > s)
    if not sorted_iv:
        return 0
    total = 0
    cur_s, cur_e = sorted_iv[0]
    for s, e in sorted_iv[1:]:
        if s <= cur_e:
            cur_e = max(cur_e, e)
        else:
            total += cur_e - cur_s
            cur_s, cur_e = s, e
    return total + (cur_e - cur_s)


def _extract_matched_sources_and_highlights(
    report: dict[str, Any],
    *,
    total_doc_chars: int,
    overall_score: float,
) -> tuple[list[ExportMatchedSource], list[ExportHighlightMatch]]:
    """
    Group matches into canonical sources across live and Supabase-reloaded report
    shapes, assign consistent colors, compute accurate non-zero match percentages,
    and build linked in-document highlight targets.
    """
    key_to_bucket: dict[str, str] = {}
    buckets: dict[str, dict[str, Any]] = {}

    def _get_bucket(record: dict[str, Any]) -> dict[str, Any]:
        b_id = _canonical_bucket_id(record, key_to_bucket)
        b = buckets.get(b_id)
        if b is None:
            b = {
                "source_kind": "web",
                "title_candidates": [],
                "explicit_pct": 0.0,
                "max_match_pct": 0.0,
                "authors": [],
                "year": None,
                "venue": None,
                "doi": None,
                "url": None,
                "matches": [],
            }
            buckets[b_id] = b
        return b

    def _absorb_meta(bucket: dict[str, Any], rec: dict[str, Any]) -> None:
        url = str(rec.get("source_url") or rec.get("url") or rec.get("source_pdf_url") or rec.get("pdf_url") or "").strip() or None
        doi = str(rec.get("source_doi") or rec.get("doi") or "").strip() or None
        raw_title = str(rec.get("source_title") or rec.get("title") or "").strip()
        kind_input = {
            "source_kind": rec.get("source_kind"),
            "source_url": url or "",
            "source_doi": doi or "",
            "source_title": raw_title,
        }
        kind: Literal["academic", "web"] = (
            "academic" if rec.get("source_kind") == "academic" or classify_source_kind(kind_input) == "academic" else "web"
        )
        if kind == "academic":
            bucket["source_kind"] = "academic"
        if raw_title:
            bucket["title_candidates"].append((raw_title, kind == "academic"))
        for author in _parse_authors(rec.get("source_authors") or rec.get("authors") or rec.get("source_author")):
            if author not in bucket["authors"]:
                bucket["authors"].append(author)
        year = _safe_int(rec.get("source_year") or rec.get("year"))
        if year and not bucket["year"]:
            bucket["year"] = year
        venue = str(rec.get("venue") or "").strip() or None
        if venue and not bucket["venue"]:
            bucket["venue"] = venue
        if doi and not bucket["doi"]:
            bucket["doi"] = doi
        if url and not bucket["url"]:
            bucket["url"] = url

    for p in report.get("matched_papers") or []:
        if not isinstance(p, dict):
            continue
        bucket = _get_bucket(p)
        _absorb_meta(bucket, p)
        explicit = _safe_float(p.get("match_percent"), 0.0)
        if explicit > 0.0:
            bucket["explicit_pct"] = max(bucket["explicit_pct"], explicit)
        sim_val = _safe_float(p.get("max_similarity"), 0.0) * 100.0
        if sim_val > 0.0:
            bucket["max_match_pct"] = max(bucket["max_match_pct"], sim_val)

    for m in report.get("matches") or []:
        if not isinstance(m, dict):
            continue
        bucket = _get_bucket(m)
        _absorb_meta(bucket, m)
        snippet = str(m.get("input_sentence") or m.get("user_snippet") or "").strip()
        if m.get("match_percent") is not None:
            pct = _safe_float(m.get("match_percent"), 0.0)
        else:
            pct = _safe_float(m.get("semantic_similarity"), 0.0) * 100.0
        bucket["max_match_pct"] = max(bucket["max_match_pct"], pct)
        offset = m.get("input_offset") if isinstance(m.get("input_offset"), dict) else {}
        start_off = _safe_int(offset.get("start"))
        end_off = _safe_int(offset.get("end"))
        bucket["matches"].append({
            "snippet": snippet,
            "match_pct": pct,
            "pdf_rects": _valid_pdf_rects(m.get("pdf_rects")),
            "start_offset": start_off,
            "end_offset": end_off,
        })

    if not buckets:
        return [], []

    # Compute unique matched character length per bucket for proportional / coverage scoring
    raw_chars_by_bucket: dict[str, int] = {}
    for b_id, b in buckets.items():
        intervals = [
            (m["start_offset"], m["end_offset"])
            for m in b["matches"]
            if m["start_offset"] is not None and m["end_offset"] is not None and m["end_offset"] > m["start_offset"]
        ]
        if intervals:
            raw_chars_by_bucket[b_id] = _merge_intervals(intervals)
        else:
            seen_snips: set[str] = set()
            total_len = 0
            for m in b["matches"]:
                norm = _normalize_ws(m["snippet"]).lower()
                if norm and norm not in seen_snips:
                    seen_snips.add(norm)
                    total_len += len(norm)
            raw_chars_by_bucket[b_id] = total_len

    total_matched_chars = sum(raw_chars_by_bucket.values())
    num_buckets = len(buckets)

    ranked_items: list[tuple[str, dict[str, Any], float]] = []
    for b_id, b in buckets.items():
        match_count = len(b["matches"])
        explicit_pct = float(b["explicit_pct"])
        if explicit_pct > 0.0:
            pct = min(100.0, explicit_pct)
        elif num_buckets == 1 and overall_score > 0.0 and match_count > 0:
            pct = min(100.0, overall_score)
        elif match_count > 0 and total_doc_chars > 0 and raw_chars_by_bucket[b_id] > 0:
            cov = raw_chars_by_bucket[b_id] / max(total_doc_chars, 1) * 100.0
            if overall_score > 0.0:
                cov = min(cov, overall_score)
            pct = min(100.0, cov)
        elif match_count > 0 and overall_score > 0.0 and total_matched_chars > 0:
            pct = overall_score * (raw_chars_by_bucket[b_id] / total_matched_chars)
        else:
            pct = min(100.0, float(b["max_match_pct"]))

        if match_count > 0:
            pct = max(0.1, round(pct, 1))
        else:
            pct = round(pct, 1)

        ranked_items.append((b_id, b, pct))

    ranked_items.sort(
        key=lambda item: (item[2], len(item[1]["matches"]), item[1]["max_match_pct"]),
        reverse=True,
    )

    sources: list[ExportMatchedSource] = []
    highlights: list[ExportHighlightMatch] = []

    for idx, (_b_id, b, pct) in enumerate(ranked_items, start=1):
        color = SOURCE_PALETTE[(idx - 1) % len(SOURCE_PALETTE)]
        is_acad = b["source_kind"] == "academic"
        cleaned_candidates = [
            _sanitize_source_title(raw_t, is_academic=is_acad or hint_acad)
            for raw_t, hint_acad in b["title_candidates"]
        ]
        cleaned_candidates = [t for t in cleaned_candidates if t]
        # Prefer a clean title without truncation ellipsis if multiple candidates exist
        non_ellipsis = [t for t in cleaned_candidates if not t.endswith("…") and not t.endswith("...")]
        if non_ellipsis:
            title = max(non_ellipsis, key=len)
        elif cleaned_candidates:
            title = max(cleaned_candidates, key=len)
        else:
            title = b["url"] or b["doi"] or f"Source #{idx}"

        sources.append(
            ExportMatchedSource(
                index=idx,
                color=color,
                source_kind="academic" if is_acad else "web",
                title=title,
                match_percent=pct,
                match_count=len(b["matches"]),
                authors=b["authors"],
                year=b["year"],
                venue=b["venue"],
                doi=b["doi"],
                url=b["url"],
            )
        )

        for m in b["matches"]:
            if not m["snippet"] and not m["pdf_rects"]:
                continue
            highlights.append(
                ExportHighlightMatch(
                    source_index=idx,
                    color=color,
                    snippet=m["snippet"],
                    match_percent=round(float(m["match_pct"]), 1),
                    pdf_rects=m["pdf_rects"],
                    start_offset=m["start_offset"],
                    end_offset=m["end_offset"],
                )
            )

    return sources, highlights


def _localize_version_label(
    raw_label: str | None,
    version_kind: Literal["original", "saved", "draft"],
    lang: Literal["en", "vi"],
) -> str:
    label = (raw_label or "").strip()
    strings = _STRINGS[lang]
    if not label:
        if version_kind == "original":
            return strings["original_version"]
        if version_kind == "draft":
            return strings["current_draft"]
        return strings["edited_version"]

    norm = label.lower()
    if lang == "vi":
        if norm in {"original document", "original upload"}:
            return "Tài liệu gốc"
        if norm == "current draft":
            return "Bản nháp hiện tại"
        m_ver = re.match(r"^version\s+(\d+)$", norm)
        if m_ver:
            return f"Phiên bản {m_ver.group(1)}"
    else:
        if norm in {"tài liệu gốc", "bản tải lên gốc"}:
            return "Original Document"
        if norm == "bản nháp hiện tại":
            return "Current Draft"
        m_ver = re.match(r"^phiên bản\s+(\d+)$", norm)
        if m_ver:
            return f"Version {m_ver.group(1)}"
    return label


def _extract_pdf_text_summary(pdf_bytes: bytes | None) -> tuple[int, int]:
    """Return (word_count, char_count) from raw PDF bytes when DB text is absent."""
    if not pdf_bytes:
        return 0, 0
    try:
        doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    except Exception:
        return 0, 0
    try:
        chunks = [doc[i].get_text() for i in range(len(doc))]
        joined = "\n".join(c for c in chunks if c)
        words = len(joined.split())
        return words, len(_normalize_ws(joined))
    finally:
        doc.close()


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
    original_text: str | None = None,
    original_pdf_bytes: bytes | None = None,
) -> ReportExportContext:
    """Assemble all report metadata, scores, sources, and highlight targets for export."""
    resolved_lang: Literal["en", "vi"] = "vi" if lang == "vi" else "en"

    blocks = html_to_structured_blocks(edited_html) if version_kind != "original" else []
    edited_text = "\n\n".join(b["text"] for b in blocks)
    base_text = (original_text or "").strip() or str(report.get("input_text") or "").strip()

    pdf_words, pdf_chars = (0, 0)
    if (not base_text and version_kind == "original") or (
        not edited_text and not base_text
    ):
        pdf_words, pdf_chars = _extract_pdf_text_summary(original_pdf_bytes)

    if version_kind != "original" and edited_text:
        word_count = len(edited_text.split())
        total_doc_chars = len(edited_text)
    else:
        if base_text:
            word_count = len(base_text.split())
            total_doc_chars = len(base_text)
        else:
            stored_wc = _safe_int(report.get("word_count")) or 0
            word_count = stored_wc if stored_wc > 0 else pdf_words
            scoring = report.get("scoring") if isinstance(report.get("scoring"), dict) else {}
            doc_meta = report.get("document") if isinstance(report.get("document"), dict) else {}
            total_doc_chars = (
                _safe_int(scoring.get("total_chars"))
                or _safe_int(doc_meta.get("total_chars"))
                or pdf_chars
                or word_count * 6
            )

    sim_score = _safe_float(report.get("overall_score"), 0.0)
    ai_block = report.get("ai_detection") if isinstance(report.get("ai_detection"), dict) else {}
    ai_score: float | None = None
    ai_level: Literal["low", "possible", "likely"] | None = None
    ai_inconclusive = bool(ai_block.get("inconclusive"))

    if ai_block:
        avail_flag = ai_block.get("available")
        if avail_flag is True or avail_flag is None:
            raw_ai = ai_block.get("overall_score") if ai_block.get("overall_score") is not None else ai_block.get("ai_score")
            if raw_ai is not None:
                ai_score = _safe_float(raw_ai)
        lvl = ai_block.get("level")
        if lvl in ("low", "possible", "likely"):
            ai_level = lvl

    if word_count <= 0:
        analyzed_words = _safe_int(ai_block.get("analyzed_words")) or 0
        if analyzed_words > 0:
            word_count = analyzed_words

    ai_available = ai_score is not None
    is_estimate = False

    if version_kind == "original":
        if snapshot_scores:
            if sim_score <= 0.0 and snapshot_scores.get("similarity_score") is not None:
                sim_score = _safe_float(snapshot_scores["similarity_score"], sim_score)
            if ai_score is None and snapshot_scores.get("ai_score") is not None:
                ai_score = _safe_float(snapshot_scores["ai_score"])
                ai_available = True
    else:
        if snapshot_scores and snapshot_scores.get("checked"):
            if snapshot_scores.get("similarity_score") is not None:
                sim_score = _safe_float(snapshot_scores["similarity_score"], sim_score)
            if snapshot_scores.get("ai_score") is not None:
                ai_score = _safe_float(snapshot_scores["ai_score"])
                ai_available = True
        else:
            is_estimate = True
            if ai_score is None and snapshot_scores and snapshot_scores.get("ai_score") is not None:
                ai_score = _safe_float(snapshot_scores["ai_score"])
                ai_available = True

    resolved_label = _localize_version_label(version_label, version_kind, resolved_lang)
    exported_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    pub_match = report.get("published_paper_match")
    if not isinstance(pub_match, dict) or not pub_match.get("title"):
        pub_match = None

    sources, highlights = _extract_matched_sources_and_highlights(
        report,
        total_doc_chars=total_doc_chars,
        overall_score=round(sim_score, 1),
    )

    return ReportExportContext(
        report_id=report_id,
        title=(title or "").strip() or "Etymos-Report",
        version_label=resolved_label,
        version_kind=version_kind,
        exported_at=exported_at,
        lang=resolved_lang,
        word_count=word_count,
        similarity_score=round(sim_score, 1),
        ai_score=round(ai_score, 1) if ai_score is not None else None,
        ai_available=ai_available,
        ai_level=ai_level,
        ai_inconclusive=ai_inconclusive,
        is_rechecked_estimate=is_estimate,
        published_paper_match=pub_match,
        matched_sources=sources,
        highlight_matches=highlights,
    )


def _render_html_to_pdf_doc(html_body: str, css: str, page_rect: pymupdf.Rect = A4_RECT) -> pymupdf.Document:
    """Render an HTML string into a multi-page PyMuPDF Document using Story and unified fonts."""
    archive, font_css = _open_font_archive()
    full_css = f"{font_css}\n{css}" if font_css else css
    story = pymupdf.Story(html=html_body, user_css=full_css, archive=archive)
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


def _inject_inline_highlights(text: str, highlight_matches: list[ExportHighlightMatch]) -> str:
    """Wrap matched snippets in pastel <span class='hl ...'> marks matching source colors."""
    if not text or not highlight_matches:
        return html.escape(text).replace("\n", "<br/>")

    candidates: list[tuple[int, int, SourceColorToken, int, float]] = []
    ordered = sorted(highlight_matches, key=lambda h: (h.source_index, -h.match_percent))
    for hm in ordered:
        words = _normalize_ws(hm.snippet).split()
        if not words:
            continue
        pattern = r"\s+".join(re.escape(w) for w in words[:40])
        try:
            for match in re.finditer(pattern, text, flags=re.IGNORECASE):
                if match.end() > match.start():
                    candidates.append(
                        (match.start(), match.end(), hm.color, hm.source_index, hm.match_percent)
                    )
        except re.error:
            continue

    if not candidates:
        return html.escape(text).replace("\n", "<br/>")

    # Prioritize lower source_index, then higher match_percent, and reject overlapping spans
    candidates.sort(key=lambda c: (c[3], -c[4], -(c[1] - c[0]), c[0]))
    accepted: list[tuple[int, int, SourceColorToken]] = []
    for s, e, col, _idx, _pct in candidates:
        if any(s < ae and as_ < e for as_, ae, _ in accepted):
            continue
        accepted.append((s, e, col))
    accepted.sort(key=lambda c: c[0])

    out: list[str] = []
    cursor = 0
    for s, e, col in accepted:
        if s > cursor:
            out.append(html.escape(text[cursor:s]).replace("\n", "<br/>"))
        seg = html.escape(text[s:e]).replace("\n", "<br/>")
        out.append(f"<span class='hl hl-{col.key}'>{seg}</span>")
        cursor = e
    if cursor < len(text):
        out.append(html.escape(text[cursor:]).replace("\n", "<br/>"))
    return "".join(out)


def _render_blocks_to_pdf_doc(
    blocks: list[dict[str, str]],
    page_rect: pymupdf.Rect = A4_RECT,
    highlight_matches: list[ExportHighlightMatch] | None = None,
) -> pymupdf.Document:
    """Render structured blocks (headings, paragraphs, list items) with optional inline highlights."""
    hl_list = highlight_matches or []
    parts: list[str] = ["<div class='doc-body'>"]
    in_list = False
    for b in blocks:
        tag = b.get("tag", "p")
        txt = _inject_inline_highlights(b.get("text", ""), hl_list)
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

    hl_css = "\n".join(
        f".hl-{col.key} {{ background-color: {col.soft_bg_hex}; border-bottom: 1.5pt solid {col.accent_hex}; }}"
        for col in SOURCE_PALETTE
    )
    css = f"""
    body {{ font-family: "EtymosSans", sans-serif; font-size: 10.5pt; line-height: 1.5; color: #111827; }}
    h1 {{ font-size: 16pt; font-weight: 700; margin: 0 0 10pt 0; color: #0f172a; }}
    h2 {{ font-size: 13pt; font-weight: 700; margin: 14pt 0 6pt 0; color: #0f172a; }}
    h3, h4 {{ font-size: 11.5pt; font-weight: 700; margin: 10pt 0 4pt 0; color: #1e293b; }}
    p {{ margin: 0 0 8pt 0; text-align: left; }}
    ul {{ margin: 0 0 8pt 16pt; padding: 0; }}
    li {{ margin: 0 0 4pt 0; }}
    blockquote {{ border-left: 2pt solid #cbd5e1; padding-left: 8pt; color: #475569; margin: 6pt 0; }}
    .hl {{ padding: 0.5pt 1pt; }}
    {hl_css}
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
        horiz_overlap = min(r.x1, target_rect.x1) - max(r.x0, target_rect.x0)
        if horiz_overlap > 6.0 and r.y0 >= target_rect.y1 - 2.0:
            limit = min(limit, r.y0 - 4.0)
    return max(target_rect.y1, limit)


def _measure_story_height(
    html_fragment: str,
    css: str,
    width: float,
    *,
    archive: pymupdf.Archive | None = None,
) -> float:
    """Measure height required to render `html_fragment` at `width`."""
    story = pymupdf.Story(html=html_fragment, user_css=css, archive=archive)
    where = pymupdf.Rect(0, 0, max(40.0, width), 10000.0)
    _, filled = story.place(where)
    return float(filled[3])


def _patch_pdf_with_edits(
    original_pdf_bytes: bytes,
    original_text: str,
    edited_blocks: list[dict[str, str]],
    lang: Literal["en", "vi"],
    highlight_matches: list[ExportHighlightMatch] | None = None,
) -> tuple[pymupdf.Document, bool, set[int], dict[int, int]]:
    """
    Surgically patch modified paragraphs in-place on the original PDF,
    preserving untouched layout, figures, tables, and page geometry.
    Returns (document, used_full_fallback, modified_page_indices, orig_to_new_page).
    """
    doc = pymupdf.open(stream=original_pdf_bytes, filetype="pdf")
    if len(doc) == 0:
        return _render_blocks_to_pdf_doc(edited_blocks, highlight_matches=highlight_matches), True, set(), {}

    base_map = {i: i for i in range(len(doc))}
    edited_paras = [b["text"] for b in edited_blocks]
    orig_paras = _extract_baseline_paragraphs(original_text)
    if not orig_paras:
        orig_paras = [blk["text"] for p in range(len(doc)) for blk in _page_text_blocks(doc[p])]

    replacements, additions = _diff_text_segments(orig_paras, edited_paras)
    if not replacements and not additions:
        return doc, False, set(), base_map

    anchored: list[tuple[int, dict[str, Any], str]] = []
    unanchored: list[str] = []
    for old_t, new_t in replacements:
        hit = _find_matching_block(doc, old_t)
        if hit is None:
            if new_t:
                unanchored.append(new_t)
        else:
            anchored.append((hit[0], hit[1], new_t))

    total_changes = len(replacements)
    if total_changes > 0 and len(unanchored) / total_changes > 0.70:
        fallback_doc = _render_blocks_to_pdf_doc(
            edited_blocks,
            page_rect=doc[0].rect,
            highlight_matches=highlight_matches,
        )
        doc.close()
        return fallback_doc, True, set(), {}

    archive, font_css = _open_font_archive()
    overflow_by_page: dict[int, list[str]] = {}
    by_page: dict[int, list[tuple[dict[str, Any], str]]] = {}
    for p_idx, blk, new_t in anchored:
        by_page.setdefault(p_idx, []).append((blk, new_t))

    modified_orig_pages = set(by_page.keys())

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
                css = (
                    f"{font_css}\n"
                    f'p {{ font-family: "EtymosSans", sans-serif; font-size: {sz}pt; '
                    f"line-height: 1.32; color: {color_hex}; margin: 0; }}"
                )
                needed_h = _measure_story_height(
                    safe_html, css, expanded_rect.width, archive=archive
                )
                if needed_h <= expanded_rect.height + 1.0:
                    page.insert_htmlbox(expanded_rect, safe_html, css=css, archive=archive)
                    placed = True
                    break

            if not placed:
                sz = round(font_size * 0.90, 2)
                css = (
                    f"{font_css}\n"
                    f'p {{ font-family: "EtymosSans", sans-serif; font-size: {sz}pt; '
                    f"line-height: 1.32; color: {color_hex}; margin: 0; }}"
                )
                words = new_t.split()
                fit_idx = len(words)
                while fit_idx > 1:
                    candidate = " ".join(words[:fit_idx]) + " …"
                    cand_html = f"<p>{html.escape(candidate)}</p>"
                    if (
                        _measure_story_height(
                            cand_html, css, expanded_rect.width, archive=archive
                        )
                        <= expanded_rect.height
                    ):
                        page.insert_htmlbox(expanded_rect, cand_html, css=css, archive=archive)
                        overflow_by_page.setdefault(p_idx, []).append(" ".join(words[fit_idx:]))
                        break
                    fit_idx = max(1, int(fit_idx * 0.8))
                else:
                    overflow_by_page.setdefault(p_idx, []).append(new_t)

    strings = _STRINGS[lang]
    for p_idx in sorted(overflow_by_page.keys(), reverse=True):
        cur_p = base_map[p_idx]
        cont_blocks = [{"tag": "h3", "text": strings["continued_heading"]}]
        for txt in overflow_by_page[p_idx]:
            cont_blocks.append({"tag": "p", "text": txt})
        cont_doc = _render_blocks_to_pdf_doc(cont_blocks, page_rect=doc[cur_p].rect)
        inserted = len(cont_doc)
        doc.insert_pdf(cont_doc, start_at=cur_p + 1)
        cont_doc.close()
        for orig_p in base_map:
            if base_map[orig_p] > cur_p:
                base_map[orig_p] += inserted

    extra_tail = unanchored + additions
    if extra_tail:
        tail_blocks = [{"tag": "p", "text": t} for t in extra_tail if t.strip()]
        if tail_blocks:
            tail_doc = _render_blocks_to_pdf_doc(tail_blocks, page_rect=doc[-1].rect)
            doc.insert_pdf(tail_doc)
            tail_doc.close()

    modified_new_pages = {base_map[p] for p in modified_orig_pages}
    return doc, False, modified_new_pages, base_map


# ---------------------------------------------------------------------------
# In-Document Translucent Vector Highlights (mirrors apps/web/src/lib/pdfRects)
# ---------------------------------------------------------------------------

def _clamp_and_merge_rects(raw_rects: list[dict[str, float]], page_rect: pymupdf.Rect, page_num: int) -> list[pymupdf.Rect]:
    clamped: list[pymupdf.Rect] = []
    for item in raw_rects:
        if int(item["page"]) != page_num:
            continue
        x0 = max(0.0, min(float(item["x0"]), page_rect.width))
        x1 = max(0.0, min(float(item["x1"]), page_rect.width))
        y0 = max(0.0, min(float(item["y0"]), page_rect.height))
        y1 = max(0.0, min(float(item["y1"]), page_rect.height))
        if x1 - x0 >= 0.5 and y1 - y0 >= 0.5:
            clamped.append(pymupdf.Rect(x0, y0, x1, y1))

    if len(clamped) <= 1:
        return clamped

    clamped.sort(key=lambda r: (r.y0, r.x0))
    merged: list[pymupdf.Rect] = []
    for r in clamped:
        if merged:
            last = merged[-1]
            min_h = min(last.height, r.height)
            v_overlap = min(last.y1, r.y1) - max(last.y0, r.y0)
            same_row = min_h > 0 and v_overlap >= 0.6 * min_h
            h_gap = r.x0 - last.x1
            if same_row and h_gap <= 4.0 and r.x0 >= last.x0 - 2.0:
                merged[-1] = pymupdf.Rect(
                    min(last.x0, r.x0),
                    min(last.y0, r.y0),
                    max(last.x1, r.x1),
                    max(last.y1, r.y1),
                )
                continue
        merged.append(r)
    return merged


def _snippet_still_present(snippet: str, normalized_active_text: str) -> bool:
    norm = _normalize_ws(snippet).lower()
    if len(norm) < 6:
        return True
    if norm in normalized_active_text:
        return True
    words = norm.split()
    if len(words) >= 6:
        head = " ".join(words[:5])
        tail = " ".join(words[-5:])
        return head in normalized_active_text and tail in normalized_active_text
    return False


def _search_snippet_rects_on_page(
    page: pymupdf.Page,
    norm_page_text: str,
    snippet: str,
) -> list[pymupdf.Rect]:
    norm_snip = _normalize_ws(snippet)
    if len(norm_snip) < 4:
        return []
    words = norm_snip.split()
    probe = " ".join(words[: min(4, len(words))]).lower()
    if probe and probe not in norm_page_text:
        return []

    hits = page.search_for(norm_snip)
    if not hits and len(words) >= 6:
        anchor_hits: list[pymupdf.Rect] = []
        for chunk in (words[:6], words[-6:]):
            anchor_hits.extend(page.search_for(" ".join(chunk)))
        hits = anchor_hits

    return [r & page.rect for r in hits if not (r & page.rect).is_empty]


@dataclass
class _PlacedHighlightBox:
    source_index: int
    match_percent: float
    color: SourceColorToken
    rect: pymupdf.Rect


def _dedupe_highlight_boxes(boxes: list[_PlacedHighlightBox]) -> list[_PlacedHighlightBox]:
    if len(boxes) <= 1:
        return boxes
    ordered = sorted(boxes, key=lambda b: (b.source_index, -b.match_percent))
    kept: list[_PlacedHighlightBox] = []
    for box in ordered:
        area = box.rect.width * box.rect.height or 1.0
        shadowed = False
        for k in kept:
            inter = box.rect & k.rect
            if inter.is_empty:
                continue
            ratio = (inter.width * inter.height) / area
            if (k.source_index != box.source_index and ratio > 0.50) or ratio > 0.85:
                shadowed = True
                break
        if not shadowed:
            kept.append(box)
    return kept


def _apply_pdf_highlights(
    doc: pymupdf.Document,
    highlight_matches: list[ExportHighlightMatch],
    *,
    active_text: str | None = None,
    modified_pages: set[int] | None = None,
    page_index_map: dict[int, int] | None = None,
) -> None:
    """Draw translucent pastel highlights + subtle bottom accents over matched passages."""
    if not highlight_matches or len(doc) == 0:
        return

    norm_active = _normalize_ws(active_text).lower() if active_text is not None else None
    mod_pages = modified_pages or set()
    page_texts: list[str] = [_normalize_ws(doc[i].get_text()).lower() for i in range(len(doc))]
    boxes_by_page: dict[int, list[_PlacedHighlightBox]] = {}

    for hm in highlight_matches:
        if norm_active is not None and not _snippet_still_present(hm.snippet, norm_active):
            continue

        placed_any = False
        touched_modified_page = False
        if hm.pdf_rects:
            pages = sorted({int(r["page"]) for r in hm.pdf_rects if int(r["page"]) >= 1})
            for page_num in pages:
                target_p = (
                    page_index_map.get(page_num - 1, page_num - 1)
                    if page_index_map is not None
                    else (page_num - 1)
                )
                if not (0 <= target_p < len(doc)):
                    continue
                if target_p in mod_pages:
                    touched_modified_page = True
                    continue
                page = doc[target_p]
                for r in _clamp_and_merge_rects(hm.pdf_rects, page.rect, page_num):
                    boxes_by_page.setdefault(target_p, []).append(
                        _PlacedHighlightBox(hm.source_index, hm.match_percent, hm.color, r)
                    )
                    placed_any = True

        # Fall back to text search when pdf_rects are missing or hit a modified page
        if not placed_any or touched_modified_page:
            target_pages = (
                mod_pages if (placed_any and touched_modified_page) else range(len(doc))
            )
            for p_idx in target_pages:
                if placed_any and p_idx not in mod_pages:
                    continue
                page = doc[p_idx]
                for r in _search_snippet_rects_on_page(page, page_texts[p_idx], hm.snippet):
                    boxes_by_page.setdefault(p_idx, []).append(
                        _PlacedHighlightBox(hm.source_index, hm.match_percent, hm.color, r)
                    )

    for p_idx, raw_boxes in boxes_by_page.items():
        page = doc[p_idx]
        kept = _dedupe_highlight_boxes(raw_boxes)
        if not kept:
            continue
        shape = page.new_shape()
        for box in kept:
            r = pymupdf.Rect(
                max(0.0, box.rect.x0 - 0.5),
                max(0.0, box.rect.y0 - 0.5),
                min(page.rect.width, box.rect.x1 + 0.5),
                min(page.rect.height, box.rect.y1 + 0.5),
            )
            shape.draw_rect(r)
            shape.finish(
                fill=box.color.fill_rgb,
                fill_opacity=box.color.fill_opacity,
                color=None,
            )
            shape.draw_line(pymupdf.Point(r.x0, r.y1), pymupdf.Point(r.x1, r.y1))
            shape.finish(
                color=box.color.accent_rgb,
                stroke_opacity=0.55,
                width=1.25,
            )
        shape.commit(overlay=True)


# ---------------------------------------------------------------------------
# Appended Report Pages (Unified Typography + Color-Matched Sources List)
# ---------------------------------------------------------------------------

def _ai_verdict_text(context: ReportExportContext, s: dict[str, str]) -> str:
    if not context.ai_available:
        return ""
    if context.ai_inconclusive:
        return s["ai_level_inconclusive"]
    if context.ai_level == "likely":
        return s["ai_level_likely"]
    if context.ai_level == "possible":
        return s["ai_level_possible"]
    if context.ai_level == "low":
        return s["ai_level_low"]
    if context.ai_score is not None:
        if context.ai_score >= 60.0:
            return s["ai_level_likely"]
        if context.ai_score >= 25.0:
            return s["ai_level_possible"]
        return s["ai_level_low"]
    return ""


def render_report_appendix_pdf(context: ReportExportContext) -> pymupdf.Document:
    """Render localized Similarity, AI, Published Paper & compact Color-Matched Sources pages."""
    s = _STRINGS[context.lang]
    ai_display = (
        f"{context.ai_score:.1f}%"
        if context.ai_available and context.ai_score is not None
        else s["ai_unavailable"]
    )
    ai_sub = _ai_verdict_text(context, s)
    academic_count = sum(1 for src in context.matched_sources if src.source_kind == "academic")
    web_count = sum(1 for src in context.matched_sources if src.source_kind == "web")
    sim_breakdown = s["source_breakdown"].format(
        total=len(context.matched_sources),
        academic=academic_count,
        web=web_count,
    )
    sim_accent = (
        "#16a34a" if context.similarity_score < 10.0 else "#d97706" if context.similarity_score < 30.0 else "#dc2626"
    )

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
        f"<td class='score-card' style='border-left: 3.5pt solid {sim_accent};'>"
        f"<div class='sc-label'>{html.escape(s['similarity_score'])}</div>"
        f"<div class='sc-val'>{context.similarity_score:.1f}%</div>"
        f"<div class='sc-sub'>{html.escape(sim_breakdown)}</div></td>",
        "<td class='score-card ai'>"
        f"<div class='sc-label'>{html.escape(s['ai_score'])}</div>"
        f"<div class='sc-val{' muted-val' if not context.ai_available else ''}'>{html.escape(ai_display)}</div>"
        + (f"<div class='sc-sub'>{html.escape(ai_sub)}</div>" if ai_sub else "")
        + "</td>",
        "</tr></table>",
    ]

    if context.is_rechecked_estimate:
        parts.append(f"<div class='notice warn'>{html.escape(s['not_rechecked_note'])}</div>")

    if context.published_paper_match:
        pub_title = _sanitize_source_title(str(context.published_paper_match.get("title") or ""))
        pub_pct = _safe_float(context.published_paper_match.get("match_percent"), context.similarity_score)
        pub_msg = s["published_paper_body"].format(title=pub_title, percent=f"{pub_pct:.1f}")
        parts.append(
            f"<div class='notice info'><strong>{html.escape(s['published_paper_title'])}</strong><br/>"
            f"{html.escape(pub_msg)}</div>"
        )

    parts.append(f"<h2>{html.escape(s['matched_sources_heading'])}</h2>")
    if context.matched_sources:
        parts.append(f"<p class='legend'>{html.escape(s['sources_legend'])}</p>")
        for src in context.matched_sources:
            kind_label = s["source_academic"] if src.source_kind == "academic" else s["source_web"]
            passage_note = ""
            if src.match_count > 0:
                tpl = s["passage_count_one"] if src.match_count == 1 else s["passage_count_many"]
                passage_note = f" · {tpl.format(count=src.match_count)}"

            meta_lines: list[str] = []
            if src.authors:
                shown_authors = ", ".join(src.authors[:4]) + (" et al." if len(src.authors) > 4 else "")
                meta_lines.append(f"<strong>{html.escape(s['authors'])}:</strong> {html.escape(shown_authors)}")
            pub_bits: list[str] = []
            if src.year:
                pub_bits.append(f"<strong>{html.escape(s['year'])}:</strong> {src.year}")
            if src.venue:
                pub_bits.append(f"<strong>{html.escape(s['venue'])}:</strong> {html.escape(src.venue)}")
            if src.doi:
                pub_bits.append(f"<strong>{html.escape(s['doi'])}:</strong> {html.escape(src.doi)}")
            if pub_bits:
                meta_lines.append(" · ".join(pub_bits))
            if src.url:
                safe_url = html.escape(src.url, quote=True)
                if src.url.lower().startswith(("http://", "https://")):
                    meta_lines.append(
                        f"<strong>{html.escape(s['url'])}:</strong> "
                        f"<a class='src-link' href='{safe_url}'>{html.escape(src.url)}</a>"
                    )
                else:
                    meta_lines.append(f"<strong>{html.escape(s['url'])}:</strong> {html.escape(src.url)}")

            parts.append(
                f"<div class='source-card' style='border-left: 4pt solid {src.color.badge_hex};'>"
                "<table class='src-layout'><tr>"
                "<td class='src-main'>"
                f"<div class='src-head'>"
                f"<span class='src-badge' style='background-color: {src.color.badge_hex};'>#{src.index}</span> "
                f"<span class='src-kind'>{html.escape(kind_label)}{html.escape(passage_note)}</span>"
                "</div>"
                f"<div class='src-title'>{html.escape(src.title)}</div>"
                + (f"<div class='src-meta'>{'<br/>'.join(meta_lines)}</div>" if meta_lines else "")
                + "</td>"
                "<td class='src-pct-col'>"
                f"<span class='src-pct' style='background-color: {src.color.soft_bg_hex}; "
                f"color: {src.color.accent_hex}; border: 0.75pt solid {src.color.badge_hex};'>"
                f"{src.match_percent:.1f}%</span>"
                "</td>"
                "</tr></table></div>"
            )
    else:
        parts.append(f"<p class='empty'>{html.escape(s['no_sources'])}</p>")

    css = """
    body { font-family: "EtymosSans", sans-serif; font-size: 9.5pt; line-height: 1.45; color: #1e293b; }
    .header { border-bottom: 2pt solid #1e3a8a; padding-bottom: 8pt; margin-bottom: 12pt; }
    .brand { font-size: 8pt; font-weight: 700; letter-spacing: 1pt; color: #2563eb; }
    h1 { font-size: 16pt; font-weight: 700; margin: 2pt 0 0 0; color: #0f172a; }
    h2 { font-size: 12pt; font-weight: 700; margin: 16pt 0 4pt 0; color: #0f172a; border-bottom: 0.75pt solid #e2e8f0; padding-bottom: 4pt; }
    .legend { font-size: 8.5pt; color: #64748b; margin: 2pt 0 10pt 0; }
    .meta-table { width: 100%; border-collapse: collapse; margin-bottom: 12pt; }
    .meta-table td { padding: 4.5pt 6pt; border-bottom: 0.5pt solid #e2e8f0; vertical-align: top; }
    .meta-table td.lbl { width: 135pt; font-weight: 600; color: #475569; }
    .score-grid { width: 100%; border-collapse: separate; border-spacing: 8pt 0; margin: 6pt -8pt 12pt -8pt; }
    .score-card { width: 50%; padding: 10pt 12pt; border: 0.75pt solid #cbd5e1; border-radius: 4pt; background-color: #f8fafc; vertical-align: top; }
    .score-card.ai { border-left: 3.5pt solid #7c3aed; }
    .sc-label { font-size: 8.5pt; color: #475569; font-weight: 600; }
    .sc-val { font-size: 18pt; font-weight: 700; color: #0f172a; margin-top: 2pt; }
    .sc-val.muted-val { font-size: 13pt; color: #64748b; padding-top: 4pt; }
    .sc-sub { font-size: 8pt; color: #64748b; margin-top: 3pt; }
    .notice { padding: 8pt 10pt; border-radius: 4pt; margin: 8pt 0; font-size: 8.75pt; }
    .notice.warn { background-color: #fffbeb; border: 0.75pt solid #f59e0b; color: #92400e; }
    .notice.info { background-color: #eff6ff; border: 0.75pt solid #3b82f6; color: #1e3a8a; }
    .source-card { border: 0.75pt solid #e2e8f0; border-radius: 4pt; padding: 8pt 10pt; margin-bottom: 8pt; background-color: #ffffff; break-inside: avoid; }
    .src-layout { width: 100%; border-collapse: collapse; }
    .src-main { vertical-align: top; padding-right: 8pt; }
    .src-pct-col { width: 64pt; vertical-align: top; text-align: right; }
    .src-head { margin-bottom: 3pt; }
    .src-badge { display: inline-block; padding: 1.5pt 5.5pt; border-radius: 3pt; color: #ffffff; font-size: 8pt; font-weight: 700; }
    .src-kind { font-size: 8pt; color: #475569; font-weight: 500; margin-left: 3pt; }
    .src-title { font-size: 10pt; font-weight: 700; color: #0f172a; margin-top: 2pt; margin-bottom: 3pt; line-height: 1.35; }
    .src-meta { font-size: 8pt; color: #475569; line-height: 1.4; }
    .src-link { color: #2563eb; text-decoration: none; word-break: break-all; }
    .src-pct { display: inline-block; padding: 2.5pt 6.5pt; border-radius: 10pt; font-size: 8.5pt; font-weight: 700; white-space: nowrap; }
    .empty { color: #64748b; font-style: italic; margin-top: 8pt; }
    """
    return _render_html_to_pdf_doc("".join(parts), css, page_rect=A4_RECT)


def generate_export_pdf(
    *,
    context: ReportExportContext,
    original_pdf_bytes: bytes | None,
    original_text: str,
    edited_html: str | None = None,
) -> bytes:
    """Build the complete exported PDF (highlighted document body + appended report pages)."""
    if context.version_kind == "original":
        if original_pdf_bytes:
            body_doc = pymupdf.open(stream=original_pdf_bytes, filetype="pdf")
            _apply_pdf_highlights(body_doc, context.highlight_matches)
        else:
            blocks = [{"tag": "p", "text": p} for p in _extract_baseline_paragraphs(original_text)]
            body_doc = _render_blocks_to_pdf_doc(
                blocks or [{"tag": "p", "text": ""}],
                highlight_matches=context.highlight_matches,
            )
    else:
        edited_blocks = html_to_structured_blocks(edited_html)
        if not edited_blocks:
            edited_blocks = [{"tag": "p", "text": p} for p in _extract_baseline_paragraphs(original_text)]
        edited_plain = "\n\n".join(b["text"] for b in edited_blocks)
        active_filter = _normalize_ws(edited_plain).lower() if context.is_rechecked_estimate else None
        active_highlights = [
            hm
            for hm in context.highlight_matches
            if active_filter is None or _snippet_still_present(hm.snippet, active_filter)
        ]
        if original_pdf_bytes:
            body_doc, used_fallback, modified_pages, page_index_map = _patch_pdf_with_edits(
                original_pdf_bytes=original_pdf_bytes,
                original_text=original_text,
                edited_blocks=edited_blocks,
                lang=context.lang,
                highlight_matches=active_highlights,
            )
            if not used_fallback:
                _apply_pdf_highlights(
                    body_doc,
                    active_highlights,
                    modified_pages=modified_pages,
                    page_index_map=page_index_map,
                )
        else:
            body_doc = _render_blocks_to_pdf_doc(edited_blocks, highlight_matches=active_highlights)

    appendix_doc = render_report_appendix_pdf(context)
    body_doc.insert_pdf(appendix_doc)
    out_bytes = body_doc.tobytes(garbage=4, deflate=True)
    appendix_doc.close()
    body_doc.close()
    return out_bytes
