"""
cited_sources.py
----------------
Drop plagiarism matches whose source the author already cites.

A matched source paper that appears in the document's own reference list
is a properly cited source, not plagiarism: its matches are removed before
the final report is built, so they are neither highlighted nor counted in
the score. Matches against sources that are NOT in the reference list go
through the normal flow unchanged.

A source counts as cited when its DOI appears in the reference list, or
its title does — compared with punctuation, case, line breaks and PDF
hyphenation ("detec- tion") ignored, with a small tolerance for a word
or two that the PDF extraction mangled.

Everything here is pure; the caller owns the report.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter

from citations import REFERENCE_HEADINGS, find_reference_section

# Headings that end the reference list when they come after it.
REFERENCE_END_HEADINGS = (
    "appendix",
    "appendices",
    "acknowledgment",
    "acknowledgement",
    "acknowledgments",
    "acknowledgements",
    "supplementary",
    "phụ lục",
    "phu luc",
    "lời cảm ơn",
)

# Exact title matching on the punctuation-free form needs at least this
# many characters; a shorter title ("Attention") would match by accident.
MIN_COMPACT_TITLE_CHARS = 20

# Fuzzy title matching: titles of at least this many words count as cited
# when a window of the reference list contains this share of their words.
MIN_FUZZY_TITLE_WORDS = 4
FUZZY_TITLE_THRESHOLD = 0.85

_HYPHEN_BREAK_RE = re.compile(r"(\w)-\s+(\w)")
_NON_WORD_RE = re.compile(r"[\W_]+", re.UNICODE)


def _strip_accents(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def _words(text: str) -> list[str]:
    """Lower-case words with punctuation and PDF line-break hyphens removed."""
    text = _strip_accents(text or "").replace("đ", "d").replace("Đ", "D")
    text = _HYPHEN_BREAK_RE.sub(r"\1\2", text)
    return [w for w in _NON_WORD_RE.split(text.lower()) if w]


def _compact(text: str) -> str:
    """Every letter and digit, nothing else — survives any spacing damage."""
    return "".join(_words(text))


def _normalize_heading(text: str) -> str:
    return " ".join((text or "").split()).strip().lower().rstrip(":").strip()


def _strip_heading_number(text: str) -> str:
    """"7. References" / "VII REFERENCES" -> "references"."""
    return re.sub(r"^(?:\d{1,2}|[ivx]{1,4})\.?\s+", "", text)


def _is_reference_heading(text: str) -> bool:
    normalized = _normalize_heading(text)
    return normalized in REFERENCE_HEADINGS or _strip_heading_number(normalized) in REFERENCE_HEADINGS


def _is_reference_end_heading(text: str) -> bool:
    normalized = _strip_heading_number(_normalize_heading(text))
    return any(normalized.startswith(name) for name in REFERENCE_END_HEADINGS)


def extract_reference_text(document: dict | None = None, input_text: str = "") -> str:
    """
    Return the text of the document's reference list ("" if it has none).

    Walks `document["blocks"]` in reading order: everything after the
    "References" heading (a zero-length section-heading block in PDFs, a
    plain heading/paragraph block in .docx and pasted text) up to an
    Appendix/Acknowledgments heading. Falls back to the last "References"
    line in the plain text when the blocks don't show one.
    """
    text = input_text or (document or {}).get("text", "") or ""
    blocks = (document or {}).get("blocks") or []

    collected: list[str] = []
    in_references = False

    for block in blocks:
        if block.get("type") == "image":
            continue
        if block.get("section_heading"):
            block_text = block.get("text") or ""
        else:
            start, end = block.get("start"), block.get("end")
            if start is None or end is None:
                continue
            block_text = text[start:end]

        if _is_reference_heading(block_text):
            # A later "References" heading restarts the list (a paper may
            # mention the word in its body).
            in_references = True
            collected = []
            continue

        if in_references:
            if block.get("type") == "heading" and _is_reference_end_heading(block_text):
                in_references = False
                continue
            collected.append(block_text)

    if collected:
        return "\n".join(collected)

    section_start = find_reference_section(text)
    if section_start is None:
        return ""
    # Skip the heading line itself.
    newline = text.find("\n", section_start)
    return text[newline + 1:] if newline != -1 else ""


class ReferenceIndex:
    """The reference list, pre-normalized once for many title lookups."""

    def __init__(self, reference_text: str):
        self.raw_lower = (reference_text or "").lower()
        self.words = _words(reference_text)
        self.compact = "".join(self.words)
        self.padded = " " + " ".join(self.words) + " "

    def __bool__(self) -> bool:
        return bool(self.words)

    def contains_doi(self, doi: str) -> bool:
        doi = (doi or "").strip().lower()
        doi = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", doi)
        return bool(doi) and doi in self.raw_lower

    def contains_title(self, title: str) -> bool:
        title_words = _words(title)
        if not title_words or not self.words:
            return False

        if (" " + " ".join(title_words) + " ") in self.padded:
            return True

        title_compact = "".join(title_words)
        if len(title_compact) >= MIN_COMPACT_TITLE_CHARS and title_compact in self.compact:
            return True

        return self._fuzzy_contains(title_words)

    def _fuzzy_contains(self, title_words: list[str]) -> bool:
        size = len(title_words)
        if size < MIN_FUZZY_TITLE_WORDS or len(self.words) < size:
            return False

        needed = Counter(title_words)
        required = FUZZY_TITLE_THRESHOLD * size
        window = Counter(self.words[:size])

        def overlap() -> int:
            return sum(min(count, window[word]) for word, count in needed.items())

        if overlap() >= required:
            return True

        for i in range(size, len(self.words)):
            window[self.words[i]] += 1
            window[self.words[i - size]] -= 1
            if self.words[i] in needed and overlap() >= required:
                return True

        return False


def is_source_cited(index: ReferenceIndex, title: str = "", doi: str = "") -> bool:
    if not index:
        return False
    return index.contains_doi(doi) or index.contains_title(title)


def filter_cited_matches(
    verified_matches: list[dict],
    document: dict | None = None,
    input_text: str = "",
    source_metadata: dict | None = None,
    matches: list[dict] | None = None,
) -> dict:
    """
    Split `verified_matches` into matches against uncited sources (kept,
    the normal flow) and matches against sources found in the document's
    reference list (dropped).

    `source_metadata` ({source_paper_id: {source_doi, ...}}) and/or the raw
    `matches` from match_chunks() supply each source's DOI;
    verified_matches only carry the id and title.

    Returns:
        {
          "kept": [...],             # verified_matches minus cited sources
          "cited_sources": [         # one entry per dropped source
            {"source_paper_id", "source_title", "source_doi",
             "excluded_sentence_matches": int}
          ],
          "reference_found": bool,   # did the document have a reference list?
        }
    """
    verified_matches = verified_matches or []
    index = ReferenceIndex(extract_reference_text(document, input_text))

    if not index:
        return {"kept": list(verified_matches), "cited_sources": [], "reference_found": False}

    doi_by_id: dict[str, str] = {}
    for match in matches or []:
        paper_id = match.get("source_paper_id")
        if paper_id and match.get("source_doi"):
            doi_by_id.setdefault(paper_id, match["source_doi"])
    for paper_id, meta in (source_metadata or {}).items():
        if (meta or {}).get("source_doi"):
            doi_by_id.setdefault(paper_id, meta["source_doi"])

    decisions: dict[str, bool] = {}
    kept: list[dict] = []
    cited: dict[str, dict] = {}

    for item in verified_matches:
        source_id = item.get("source_paper_id") or ""
        title = item.get("source_title") or ""

        if source_id not in decisions:
            decisions[source_id] = is_source_cited(index, title=title, doi=doi_by_id.get(source_id, ""))

        if not decisions[source_id]:
            kept.append(item)
            continue

        entry = cited.setdefault(source_id, {
            "source_paper_id": source_id,
            "source_title": title,
            "source_doi": doi_by_id.get(source_id, ""),
            "excluded_sentence_matches": 0,
        })
        entry["excluded_sentence_matches"] += len(item.get("sentence_matches") or [])

    return {"kept": kept, "cited_sources": list(cited.values()), "reference_found": True}
