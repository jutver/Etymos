"""
document_model.py
-----------------
Canonical, offset-addressable document model for a checked submission.

Everything downstream of extraction (chunking, sentence matching, match
localization, the plagiarism percentage) needs ONE agreed string with ONE
coordinate system. That string is `document["text"]`, and it is exactly
what the API returns as `report["input_text"]`. Every offset the backend
emits (`match["input_offset"]["start"] / ["end"]`) is a character index
into that string, so the frontend can highlight the true span with
`text.slice(start, end)` instead of re-finding the sentence heuristically.

Design note (see PLAN_CHANGES.md, P8): a LaTeX backend format was
considered and rejected — it forces every edit through a compile step and
cannot round-trip arbitrary PDF input. A structured JSON model (blocks +
character offsets) gives the same precise-anchoring benefit without a
compiler, and is what this module builds.

Block structure is deliberately shallow. PDF extraction (extractor.py)
flattens each section to a single cleaned line, so in practice a section
yields one paragraph block. The block list is still emitted because it is
the cheap groundwork an editable-document view needs later: stable ids,
section identity, and start/end offsets that survive edits via an offset
map. Faithful PDF reflow is explicitly out of scope.
"""

from __future__ import annotations

import re
from collections import Counter

# Order in which sections are laid out in the canonical document text.
# Matches the insertion order of extractor.extract_sections_from_pdf() so
# the canonical text reads like the original paper. Sections absent or
# empty are skipped entirely (they contribute no offsets and no chars).
SECTION_ORDER = [
    "title",
    "abstract",
    "introduction",
    "related_work",
    "method",
    "experiment",
    "conclusion",
    # Catch-all for content extract_structured_sections_from_pdf() (and the
    # docx extractor) could not place in a recognized academic bucket.
    # Placed last so a document that DOES have real structure still reads
    # in natural order first. See extractor.FALLBACK_SECTION.
    "body",
]

SECTION_LABELS = {
    "title": "Title",
    "abstract": "Abstract",
    "introduction": "Introduction",
    "related_work": "Related Work",
    "method": "Method",
    "experiment": "Experiment",
    "conclusion": "Conclusion",
    "body": "Body",
    "input_text": "Text",
}

# Separator inserted between two consecutive sections in the canonical
# text. Kept identical to the `"\n\n".join(...)` the old main.py used to
# build `input_text`, so the rendered document is unchanged apart from
# sections that were previously dropped.
SECTION_SEPARATOR = "\n\n"

# Weight applied to a matched character, by sentence-match label. Same
# values final_report_builder used before; kept here because scoring is
# now a property of document coverage, not of the match list.
LABEL_WEIGHT = {
    "likely_plagiarism": 1.0,
    "suspicious": 0.5,
    "common_academic_definition": 0.1,
}

DOCUMENT_MODEL_VERSION = 1


def _ordered_section_names(sections: dict) -> list[str]:
    """Known sections first in canonical order, then any extra keys in
    their own insertion order (doan_van.py uses a single `input_text`
    pseudo-section)."""
    known = [name for name in SECTION_ORDER if name in sections]
    extra = [name for name in sections if name not in SECTION_ORDER]
    return known + extra


def _split_paragraphs(text: str, base: int) -> list[tuple[int, int]]:
    """Return (start, end) spans of paragraphs within `text`, offset by
    `base`. Splits on blank lines, then on single newlines; a section with
    neither yields one paragraph covering the whole section."""
    spans: list[tuple[int, int]] = []
    cursor = 0
    length = len(text)

    while cursor < length:
        # Find the next blank-line or newline break.
        break_at = text.find("\n", cursor)
        if break_at == -1:
            spans.append((cursor, length))
            break

        end = break_at
        # Consume the run of whitespace that forms the break.
        next_start = break_at
        while next_start < length and text[next_start] in "\r\n \t":
            next_start += 1

        if end > cursor:
            spans.append((cursor, end))
        cursor = next_start

    if not spans:
        spans = [(0, length)]

    return [
        (base + start, base + end)
        for start, end in spans
        if end > start
    ]


def build_document(sections: dict, structured_sections: dict | None = None) -> dict:
    """
    Build the canonical document from a `sections` dict (as returned by
    extractor.extract_sections_from_pdf/flatten_structured_sections, or the
    two-key dict doan_van.py builds for the pasted-text path).

    `structured_sections`, when given, is the `sections` half of
    extractor.extract_structured_sections_from_pdf()'s return value (or the
    docx extractor's equivalent): `{section_name: [block, ...]}` where each
    block is `{"type", "level", "list_type", "text", "page"}`. Each
    section's flattened `sections[name]` string MUST have been built by
    joining those same blocks' `text` with "\\n\\n" (flatten_structured_sections
    does this) — that guarantees `_split_paragraphs` recovers exactly one
    span per block, in the same order, so they can be zipped to attach
    `block_type` / `level` / `list_type` / `page` to the right span. If the
    counts ever mismatch (a caller passed sections that weren't built this
    way) we silently fall back to the plain "paragraph" typing below rather
    than mis-tag content — never crash on this being best-effort.

    Returns:
        {
          "version": 1,
          "text": str,                # the canonical document string
          "total_chars": int,         # len(text)
          "sections": [
            {"section": "abstract", "label": "Abstract",
             "start": int, "end": int}          # offsets into text
          ],
          "section_offsets": {"abstract": int}, # section -> start offset
          "blocks": [
            {"block_id": "abstract_0", "section": "abstract",
             "label": "Abstract", "type": "paragraph", "index": 0,
             "start": int, "end": int,
             # present only when structured_sections supplied a match:
             "level": 1, "list_type": "bullet", "page": 3}
          ]
        }

    `section_offsets` maps a section name to the start offset of its
    *stripped* text — which is precisely the coordinate space
    extractor.build_chunks_from_sections() chunks in, so
    `section_offset + chunk_start_char` is a valid document offset.
    """
    parts: list[str] = []
    section_entries: list[dict] = []
    blocks: list[dict] = []
    cursor = 0
    structured_sections = structured_sections or {}

    for name in _ordered_section_names(sections):
        raw = sections.get(name) or ""
        if not isinstance(raw, str):
            continue

        content = raw.strip()
        if not content:
            continue

        if parts:
            parts.append(SECTION_SEPARATOR)
            cursor += len(SECTION_SEPARATOR)

        start = cursor
        parts.append(content)
        cursor += len(content)

        section_entries.append({
            "section": name,
            "label": SECTION_LABELS.get(name, name.replace("_", " ").title()),
            "start": start,
            "end": cursor,
        })

        spans = _split_paragraphs(content, start)
        struct_blocks = structured_sections.get(name) or []
        type_hints = struct_blocks if len(struct_blocks) == len(spans) else None

        for index, (p_start, p_end) in enumerate(spans):
            hint = type_hints[index] if type_hints else None
            block = {
                "block_id": f"{name}_{index}",
                "section": name,
                "label": SECTION_LABELS.get(name, name.replace("_", " ").title()),
                "type": "title" if name == "title" else (hint["type"] if hint else "paragraph"),
                "index": index,
                "start": p_start,
                "end": p_end,
            }
            if hint:
                if hint.get("level") is not None:
                    block["level"] = hint["level"]
                if hint.get("list_type"):
                    block["list_type"] = hint["list_type"]
                if hint.get("rows") is not None:
                    block["rows"] = hint["rows"]
                if hint.get("page") is not None:
                    block["page"] = hint["page"]
            blocks.append(block)

    text = "".join(parts)

    return {
        "version": DOCUMENT_MODEL_VERSION,
        "text": text,
        "total_chars": len(text),
        "sections": section_entries,
        "section_offsets": {entry["section"]: entry["start"] for entry in section_entries},
        "blocks": blocks,
    }


# =========================
# Sentence segmentation with spans
# =========================
#
# Lives here rather than in sentence_matcher.py because it is pure text
# segmentation with no model dependency — sentence_matcher pulls in the
# embedding stack, and offset logic should stay testable without it.

SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?])\s+|(?<=\))\s+(?=[A-Z])")

MIN_SENTENCE_CHARS = 40


def split_sentences_with_spans(text, min_chars=MIN_SENTENCE_CHARS):
    """
    Split `text` into sentences WITHOUT losing their position.

    Returns a list of {"text", "start", "end"} where start/end are
    character offsets into the *original* `text` argument, so
    `text[start:end]` is the untouched source span.

    The previous sentence_matcher.split_sentences() collapsed whitespace
    before splitting, which made offsets unrecoverable — the reason match
    localization had to be approximated downstream. Splitting on the raw
    string yields identical sentence boundaries (`\\s+` matches the runs
    that collapsing produced), so results are unchanged; only the
    returned span information is new.

    The returned "text" is still whitespace-normalized, because every
    downstream similarity function and the API response expect the clean
    form.
    """
    raw = text or ""
    spans = []
    cursor = 0

    for boundary in SENTENCE_BOUNDARY.finditer(raw):
        spans.append((cursor, boundary.start()))
        cursor = boundary.end()

    spans.append((cursor, len(raw)))

    sentences = []

    for start, end in spans:
        segment = raw[start:end]

        lead = len(segment) - len(segment.lstrip())
        trail = len(segment) - len(segment.rstrip())

        exact_start = start + lead
        exact_end = end - trail

        if exact_end <= exact_start:
            continue

        normalized = re.sub(r"\s+", " ", raw[exact_start:exact_end])

        if len(normalized) >= min_chars:
            sentences.append({
                "text": normalized,
                "start": exact_start,
                "end": exact_end
            })

    return sentences


def block_at_offset(document: dict, offset: int) -> str | None:
    """Return the block_id containing `offset`, or None."""
    for block in document.get("blocks") or []:
        if block["start"] <= offset < block["end"]:
            return block["block_id"]
    return None


def section_at_offset(document: dict, offset: int) -> str | None:
    """Return the section name containing `offset`, or None."""
    for entry in document.get("sections") or []:
        if entry["start"] <= offset < entry["end"]:
            return entry["section"]
    return None


def weighted_coverage(intervals, total_chars: int) -> dict:
    """
    Compute matched-character coverage over the document.

    `intervals` is an iterable of (start, end, weight). Intervals may
    overlap freely — the same sentence is routinely matched against
    several source papers, and a chunk overlap of 150 chars means
    neighbouring chunks report overlapping spans. Each character is
    therefore counted AT MOST ONCE, at the highest weight of any interval
    covering it. This is the whole point of the new formula: the old one
    summed sentence lengths and could double- or triple-count the same
    prose.

    Returns:
        {
          "total_chars": int,      # document length, the denominator
          "covered_chars": int,    # union length, unweighted
          "matched_chars": float,  # union length, weighted by label
          "score": float,          # matched_chars / total_chars * 100
          "raw_coverage": float,   # covered_chars / total_chars * 100
        }
    """
    events: list[tuple[int, int, float]] = []

    for start, end, weight in intervals:
        if start is None or end is None:
            continue
        start = max(0, int(start))
        end = min(int(end), total_chars) if total_chars else int(end)
        if end <= start or weight <= 0:
            continue
        events.append((start, 0, float(weight)))
        events.append((end, 1, float(weight)))

    covered = 0
    matched = 0.0

    if events:
        # (position, kind) with kind 0 = open sorted before 1 = close so
        # abutting intervals [a,b) [b,c) don't briefly empty the active set
        # in a way that loses a character.
        events.sort(key=lambda item: (item[0], item[1]))
        active: Counter = Counter()
        previous = events[0][0]

        for position, kind, weight in events:
            if position > previous and active:
                span = position - previous
                covered += span
                matched += span * max(active.keys())
            if kind == 0:
                active[weight] += 1
            else:
                active[weight] -= 1
                if active[weight] <= 0:
                    del active[weight]
            previous = position

    score = 0.0
    raw = 0.0
    if total_chars > 0:
        score = min(100.0, matched / total_chars * 100)
        raw = min(100.0, covered / total_chars * 100)

    return {
        "total_chars": total_chars,
        "covered_chars": covered,
        "matched_chars": round(matched, 2),
        "score": round(score, 2),
        "raw_coverage": round(raw, 2),
    }
