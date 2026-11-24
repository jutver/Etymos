"""Shared source title cleaning across report generation, AI explain, storage, and PDF export."""

from __future__ import annotations

import re

from search_paper.paper_identity import strip_preprint_prefix


def _normalize_ws(text: str | None) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())


def sanitize_source_title(raw_title: str | None, *, is_academic: bool = False, max_length: int = 160) -> str:
    """Clean concatenated multi-result titles, mirror tags, and preprint prefixes into one readable title."""
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
                c
                for c in candidates
                if not re.search(r"(?:^|\s)[\w\-]+/[\w\-]+|\b(?:Hugging Face|GitHub)\b", c, re.IGNORECASE)
            ]
            pool = non_mirror or candidates
            matching_head = [
                c
                for c in pool
                if head_prefix and re.sub(r"[^a-z0-9]+", " ", c.lower()).strip().startswith(head_prefix[:14])
            ]
            if matching_head:
                complete = [
                    c
                    for c in matching_head
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

    if len(cleaned) > max_length:
        cut = cleaned[: max_length - 1].rsplit(" ", 1)[0].strip() or cleaned[: max_length - 1]
        cleaned = f"{cut}…"
    return cleaned
