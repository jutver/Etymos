"""
citations.py
------------
"Cite this source" for the report editor.

Adding a citation does three things at once, and they have to stay
consistent with each other:

  1. an inline numeric marker `[n]` is inserted at the caret,
  2. the source is appended to the document's reference section,
  3. every existing citation is renumbered so markers read 1, 2, 3… in
     order of first appearance, and the reference list is reordered to
     match.

Everything here is pure: text in, text out. The caller owns the document.
The response carries an `offset_map` so the caller can rebase any
character offsets it is holding (match highlights, selections) onto the
edited text without re-running the whole analysis.

Contract for inline markers: a marker is `[n]` where 1 <= n <=
len(references). Bracketed text that isn't a managed marker (e.g. `[see
also]`, or `[9]` when only 3 references exist) is left completely
untouched and ignored by renumbering.
"""

from __future__ import annotations

import re

MARKER_PATTERN = re.compile(r"\[(\d{1,3})\]")

DEFAULT_REFERENCE_HEADING = "References"

# Headings that mark the start of an existing reference section. Matched
# case-insensitively on a line of its own.
REFERENCE_HEADINGS = [
    "references",
    "reference",
    "bibliography",
    "tài liệu tham khảo",
    "tai lieu tham khao",
]

SECTION_SEPARATOR = "\n\n"


def format_reference(reference: dict) -> str:
    """Render one reference entry (APA-ish, degrades gracefully when
    fields are missing — search-API metadata is frequently partial)."""
    authors = reference.get("authors") or ""
    if isinstance(authors, list):
        authors = ", ".join(str(a) for a in authors if str(a).strip())

    year = reference.get("year")
    title = (reference.get("title") or "").strip()
    url = (reference.get("url") or reference.get("pdf_url") or "").strip()

    parts = []
    if authors:
        # Never strip the author's trailing dot — it is usually an
        # initial ("Nguyen, A."), not sentence punctuation.
        author_text = str(authors).strip()
        parts.append(author_text if author_text.endswith(".") else author_text + ".")
    if year:
        parts.append(f"({year}).")
    if title:
        parts.append(title.rstrip(".") + ".")
    if url:
        parts.append(url)

    return " ".join(parts) if parts else (reference.get("id") or "Untitled source")


def render_reference_section(references: list[dict], heading: str = DEFAULT_REFERENCE_HEADING) -> str:
    """Render the whole reference section, numbered to match the inline
    markers (list position == marker number)."""
    lines = [heading]
    for index, reference in enumerate(references, 1):
        lines.append(f"[{index}] {format_reference(reference)}")
    return "\n".join(lines)


def find_reference_section(text: str) -> int | None:
    """Return the offset at which the document's reference section
    starts, or None if it has none. Uses the LAST matching heading line,
    since a paper may mention the word "references" in its body."""
    found = None

    for match in re.finditer(r"(?m)^[ \t]*(.+?)[ \t]*$", text or ""):
        line = match.group(1).strip().lower().rstrip(":")
        if line in REFERENCE_HEADINGS:
            found = match.start()

    return found


def _reference_id(reference: dict, fallback_index: int) -> str:
    for key in ("id", "source_paper_id", "paper_id", "url"):
        value = reference.get(key)
        if value:
            return str(value)
    title = (reference.get("title") or "").strip()
    return title or f"ref_{fallback_index}"


def _apply_edits(text: str, edits: list[tuple[int, int, str]]) -> tuple[str, list[dict]]:
    """
    Apply non-overlapping (start, end, replacement) edits to `text`.

    Returns (new_text, offset_map) where offset_map is a sorted list of
    {"at": old_offset, "delta": cumulative_shift}. To rebase an old
    offset: take the delta of the LAST entry whose "at" is <= the old
    offset (0 if none) and add it. Entries are emitted at each edit's
    END, so offsets after an edit rebase exactly; offsets landing inside
    an edited span were pointing at a rewritten marker and are stale by
    definition.
    """
    # (start, end): a zero-width insertion at position p must be applied
    # BEFORE a replacement that also starts at p, otherwise the insertion
    # falls behind the cursor and is silently dropped.
    edits = sorted(edits, key=lambda e: (e[0], e[1]))

    pieces = []
    offset_map: list[dict] = []
    cursor = 0
    delta = 0

    for start, end, replacement in edits:
        if start < cursor:
            continue  # defensive: skip overlapping edits
        pieces.append(text[cursor:start])
        pieces.append(replacement)
        delta += len(replacement) - (end - start)
        offset_map.append({"at": end, "delta": delta})
        cursor = end

    pieces.append(text[cursor:])

    return "".join(pieces), offset_map


def add_citation(
    text: str,
    references: list[dict],
    insert_at: int,
    source: dict,
    heading: str = DEFAULT_REFERENCE_HEADING,
) -> dict:
    """
    Insert a citation for `source` at `insert_at`, renumber every managed
    marker in order of first appearance, and rebuild the reference
    section.

    Args:
        text:       the full document text (body, optionally already
                    containing a reference section at the end).
        references: current references, in marker-number order — index 0
                    is `[1]`.
        insert_at:  caret offset in `text`. Clamped into the body.
        source:     the source to cite: {id?, title, authors, year, url}.
                    If a reference with the same id already exists it is
                    reused rather than duplicated.

    Returns:
        {
          "text": str,                    # the full edited document
          "references": [ ... ],          # reordered, marker order
          "reference_section": str,       # rendered section
          "reference_section_start": int, # its offset in "text"
          "citation_number": int,         # number of the marker inserted
          "inserted_marker": "[2]",
          "insert_at": int,               # clamped caret used
          "renumbered": bool,             # existing markers changed?
          "offset_map": [{"at", "delta"}] # rebase body offsets with this
        }
    """
    text = text or ""
    references = [dict(r) for r in (references or [])]

    # --- split body from any existing reference section -----------------
    section_start = find_reference_section(text)
    body = text if section_start is None else text[:section_start].rstrip()

    insert_at = max(0, min(int(insert_at), len(body)))

    # --- identify the reference being cited -----------------------------
    ids = [_reference_id(r, i) for i, r in enumerate(references)]
    source_id = _reference_id(source, len(references))

    if source_id in ids:
        target_id = source_id
    else:
        target_id = source_id
        entry = dict(source)
        entry["id"] = source_id
        references.append(entry)
        ids.append(source_id)

    by_id = {ref_id: references[i] for i, ref_id in enumerate(ids)}

    # --- collect citation events in document order ----------------------
    # (position, is_insertion, span, ref_id)
    events = []

    for marker in MARKER_PATTERN.finditer(body):
        number = int(marker.group(1))
        if not (1 <= number <= len(ids)):
            continue  # not a managed marker — leave verbatim
        events.append((marker.start(), 0, (marker.start(), marker.end()), ids[number - 1]))

    events.append((insert_at, 1, None, target_id))
    events.sort(key=lambda e: (e[0], e[1]))

    # --- assign numbers by first appearance -----------------------------
    order: list[str] = []
    for _, _, _, ref_id in events:
        if ref_id not in order:
            order.append(ref_id)

    # References never cited in the body keep their relative order, after
    # the cited ones — dropping them would silently lose bibliography.
    for ref_id in ids:
        if ref_id not in order:
            order.append(ref_id)

    numbers = {ref_id: index for index, ref_id in enumerate(order, 1)}

    # --- rewrite markers -------------------------------------------------
    edits: list[tuple[int, int, str]] = []
    renumbered = False

    for position, is_insertion, span, ref_id in events:
        replacement = f"[{numbers[ref_id]}]"
        if is_insertion:
            edits.append((position, position, replacement))
        else:
            if body[span[0]:span[1]] != replacement:
                renumbered = True
            edits.append((span[0], span[1], replacement))

    new_body, offset_map = _apply_edits(body, edits)

    # --- rebuild the reference section ----------------------------------
    ordered_references = [by_id[ref_id] for ref_id in order if ref_id in by_id]
    reference_section = render_reference_section(ordered_references, heading=heading)

    new_body = new_body.rstrip()
    reference_section_start = len(new_body) + len(SECTION_SEPARATOR)
    new_text = new_body + SECTION_SEPARATOR + reference_section

    return {
        "text": new_text,
        "references": ordered_references,
        "reference_section": reference_section,
        "reference_section_start": reference_section_start,
        "citation_number": numbers[target_id],
        "inserted_marker": f"[{numbers[target_id]}]",
        "insert_at": insert_at,
        "renumbered": renumbered,
        "offset_map": offset_map,
    }


def rebase_offset(offset: int, offset_map: list[dict]) -> int:
    """Rebase a pre-edit offset onto the edited text using `offset_map`.
    Provided so the backend and frontend agree on the semantics."""
    delta = 0
    for point in offset_map or []:
        if point["at"] <= offset:
            delta = point["delta"]
        else:
            break
    return offset + delta
