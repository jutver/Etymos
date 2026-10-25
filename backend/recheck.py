"""
recheck.py
----------
Save & re-check (PLAN.md): re-check an edited document by running the full
pipeline on only the paragraphs that changed.

Input is the Report editor's blocks in reading order, `[{block_id, text}]`,
where block_id is the document_passages id the editor rendered. The result is
a complete report in the same shape build_final_report returns, for a new
canonical document built from those blocks:

  * Unchanged blocks keep their previous matches. Each match is found again by
    its sentence text inside its (unchanged) block, so it lands on the right
    offsets however much the blocks before it grew or shrank. This also works
    for old reports whose matches carry no offsets.
  * Runs of changed blocks are chunked and go through metadata -> search ->
    rank -> download -> match -> verify -> cited filter, with the previous
    report's sources added to the candidate pool, so an edit that copies a
    source the report already found is still caught.
  * The score is final_report_builder.coverage_score over the merged matches,
    the same formula a fresh check uses.

AI-content detection runs again over the whole edited document (it scores
paragraph by paragraph, so a partial run would mix two models' views of the
text), along with the plain-language explanations — report_enrichment, the
same step a fresh check ends with. If it can't run, the previous AI result is
kept and marked `stale`.
"""

from __future__ import annotations

import logging
import re
from collections import Counter
from difflib import SequenceMatcher
from typing import Any, Callable, Optional

from document_model import SECTION_LABELS, block_at_offset

logger = logging.getLogger(__name__)

ProgressCallback = Callable[..., None]

SECTION = "input_text"
SEPARATOR = "\n\n"

# Formatting carried from the stored passage onto the new block.
_PASSAGE_FIELDS = ("level", "list_type", "page")

_WS_RE = re.compile(r"\s+")


def normalize_block_text(text: str) -> str:
    """One block is one paragraph: collapse every whitespace run to a space."""
    return _WS_RE.sub(" ", text or "").strip()


_MAX_BADGE_DIGITS = 3


def only_badges_added(text: str, stored: str) -> bool:
    """
    True when `text` is `stored` plus nothing but short digit runs.

    The editor used to draw each highlight's source number as a <sup> and read
    the text back with innerText, so an untouched paragraph arrived as
    "…new best results.41" (or "o62n" when a highlight ended mid-word). A
    browser still running that bundle must not make every highlighted
    paragraph count as changed.
    """
    if len(text) <= len(stored):
        return False
    for tag, i1, i2, j1, j2 in SequenceMatcher(None, stored, text, autojunk=False).get_opcodes():
        if tag == "equal":
            continue
        inserted = text[j1:j2]
        if tag != "insert" or not inserted.isdigit() or len(inserted) > _MAX_BADGE_DIGITS:
            return False
    return True


def _emit(callback: Optional[ProgressCallback], progress: int, step: str, message: str) -> None:
    if callback is None:
        return
    try:
        callback(progress=progress, step=step, message=message)
    except Exception:
        logger.exception("Re-check progress callback failed")


# --- the edited document --------------------------------------------------------

def previous_block_texts(report: dict[str, Any]) -> list[str]:
    """The previous check's paragraphs, from its document blocks (or its whole
    input_text when it has none)."""
    text = report.get("input_text") or ""
    blocks = (report.get("document") or {}).get("blocks") or []
    out = []
    for block in blocks:
        start, end = block.get("start"), block.get("end")
        if start is None or end is None:
            continue
        piece = normalize_block_text(text[start:end]) or normalize_block_text(block.get("text") or "")
        if piece:
            out.append(piece)
    if not out and text.strip():
        out = [normalize_block_text(text)]
    return out


def report_match(match: dict[str, Any]) -> dict[str, Any]:
    """
    A match in build_final_report's shape. The full report lives in the
    server's local JSON, which a redeploy wipes; the fallback is the Supabase
    copy, whose document_matches rows name the sentence `user_snippet` and
    keep the label only inside `explanation_facts`. Without converting them a
    re-check would find none of the previous matches.
    """
    if match.get("input_sentence") or not match.get("user_snippet"):
        return match
    facts = match.get("explanation_facts") or {}
    authors = match.get("source_author") or ""
    return {
        "source_title": match.get("source_title") or "",
        "source_url": match.get("source_url") or "",
        "source_kind": match.get("source_kind") or "academic",
        "source_authors": [a.strip() for a in authors.split(",") if a.strip()],
        "source_year": match.get("source_year") or "",
        "source_doi": match.get("source_doi") or "",
        "input_sentence": match["user_snippet"],
        "source_sentence": match.get("source_snippet") or "",
        "label": facts.get("label") or "",
        "semantic_similarity": float(match.get("match_percent") or 0.0) / 100,
        "explanation": match.get("explanation") or "",
        "explanation_facts": facts or None,
        "pdf_rects": match.get("pdf_rects"),
    }


def full_report(report: dict[str, Any], passages: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """
    `report` with its document blocks and input_text, the shape that can be
    stored in document_checks and restored later. The Supabase copy has
    neither, so they are rebuilt from the stored passages (`passages`, in
    document order) and its matches converted. Without passages the copy is
    returned as it is; it then has no input_text, which callers treat as
    "can't be stored".
    """
    if report.get("input_text") and (report.get("document") or {}).get("blocks"):
        return report
    blocks = [{"block_id": passage_id, "text": passage.get("text") or ""} for passage_id, passage in passages.items()]
    document, _ = build_edited_document(blocks, passages, [])
    if not document["text"]:
        return report
    return {
        **report,
        "matches": [report_match(m) for m in report.get("matches") or []],
        "input_text": document["text"],
        "document": {
            "version": document["version"],
            "total_chars": document["total_chars"],
            "sections": document["sections"],
            "blocks": document["blocks"],
            "text_field": "input_text",
        },
    }


def build_edited_document(
    blocks: list[dict[str, Any]],
    passages: dict[str, dict[str, Any]],
    previous_texts: list[str],
) -> tuple[dict[str, Any], list[bool]]:
    """
    The canonical document (document_model.build_document's shape, one
    "input_text" section, one paragraph per block) for the editor's blocks,
    and which blocks changed.

    A block is unchanged when its text equals its stored passage's text, or,
    with no stored passage for its id (e.g. no Supabase in local dev), when
    the same text was a paragraph of the previous check. Images keep their
    stored position; formatting (heading level, list type, page, table rows,
    bold/italic) is kept from the passage, the last two only while the text
    is unchanged.
    """
    remaining = Counter(previous_texts)
    parts: list[str] = []
    doc_blocks: list[dict[str, Any]] = []
    changed: list[bool] = []
    cursor = 0
    label = SECTION_LABELS.get(SECTION, "Text")

    for block in blocks:
        passage = passages.get(str(block.get("block_id"))) or {}
        block_type = passage.get("block_type") or "paragraph"

        if block_type == "image":
            if passage.get("image_url"):
                doc_blocks.append({
                    "block_id": f"{SECTION}_{len(doc_blocks)}", "section": SECTION, "label": label,
                    "type": "image", "index": len(doc_blocks), "start": cursor, "end": cursor,
                    "image_url": passage["image_url"],
                    **({"page": passage["page"]} if passage.get("page") is not None else {}),
                })
            continue

        text = normalize_block_text(block.get("text") or "")
        if not text:
            continue

        if passage:
            stored = normalize_block_text(passage.get("text") or "")
            if text != stored and only_badges_added(text, stored):
                text = stored
            is_changed = text != stored
        else:
            is_changed = remaining[text] <= 0
        if not is_changed:
            remaining[text] -= 1

        if parts:
            parts.append(SEPARATOR)
            cursor += len(SEPARATOR)
        start = cursor
        parts.append(text)
        cursor += len(text)

        doc_block: dict[str, Any] = {
            "block_id": f"{SECTION}_{len(doc_blocks)}", "section": SECTION, "label": label,
            "type": block_type, "index": len(doc_blocks), "start": start, "end": cursor,
        }
        for field in _PASSAGE_FIELDS:
            if passage.get(field) is not None:
                doc_block[field] = passage[field]
        if not is_changed:
            if passage.get("table_rows") is not None:
                doc_block["rows"] = passage["table_rows"]
            if block_type == "table" and passage.get("image_url"):
                # A table shown as a picture of itself keeps its picture.
                doc_block["image_url"] = passage["image_url"]
            if passage.get("text_marks"):
                doc_block["marks"] = passage["text_marks"]
        doc_blocks.append(doc_block)
        changed.append(is_changed)

    text = "".join(parts)
    document = {
        "version": 1,
        "text": text,
        "total_chars": len(text),
        "sections": [{"section": SECTION, "label": label, "start": 0, "end": len(text)}] if text else [],
        "section_offsets": {SECTION: 0},
        "blocks": doc_blocks,
    }
    return document, changed


def _text_blocks(document: dict[str, Any]) -> list[dict[str, Any]]:
    return [b for b in document["blocks"] if b["type"] != "image"]


def changed_runs(document: dict[str, Any], changed: list[bool]) -> list[tuple[int, int]]:
    """(start, end) document spans of each run of consecutive changed blocks."""
    runs: list[tuple[int, int]] = []
    for block, is_changed in zip(_text_blocks(document), changed):
        if not is_changed:
            continue
        if runs and document["text"][runs[-1][1]:block["start"]] == SEPARATOR:
            runs[-1] = (runs[-1][0], block["end"])
        else:
            runs.append((block["start"], block["end"]))
    return runs


# --- carrying matches over ------------------------------------------------------

def carry_over_matches(
    previous_matches: list[dict[str, Any]],
    document: dict[str, Any],
    changed: list[bool],
) -> list[dict[str, Any]]:
    """
    Previous matches whose sentence sits in unchanged text, moved to its new
    position. Matches touching a changed or removed block are dropped (changed
    text is matched again from scratch).

    Sentences are split on sentence boundaries, not paragraph breaks, so one
    can run across blocks (a heading and the line after it, a line broken by
    an equation). It is looked for in each run of consecutive unchanged
    blocks, with any whitespace between its words, so it survives as long as
    every block it touches is unchanged.
    """
    text = document["text"]
    runs: list[tuple[int, int]] = []
    in_run = False
    for block, is_changed in zip(_text_blocks(document), changed):
        if is_changed:
            in_run = False
            continue
        if in_run and text[runs[-1][1]:block["start"]] == SEPARATOR:
            runs[-1] = (runs[-1][0], block["end"])
        else:
            runs.append((block["start"], block["end"]))
        in_run = True
    carried: list[dict[str, Any]] = []
    seen: set[tuple[Any, int, int]] = set()

    for match in previous_matches:
        sentence = normalize_block_text(match.get("input_sentence") or "")
        if not sentence:
            continue
        old_offset = match.get("input_offset") or {}
        old_start = old_offset.get("start")
        pattern = re.compile(r"\s+".join(re.escape(word) for word in sentence.split(" ")))

        # Candidates: every occurrence in unchanged text. With several, prefer
        # the one nearest the old position (repeated boilerplate).
        hits: list[tuple[int, int]] = []
        for run_start, run_end in runs:
            for found in pattern.finditer(text[run_start:run_end]):
                hits.append((run_start + found.start(), run_start + found.end()))
        if not hits:
            continue
        start, end = min(hits, key=lambda h: abs(h[0] - old_start)) if old_start is not None else hits[0]

        key = (match.get("source_paper_id") or match.get("source_title"), start, end)
        if key in seen:
            continue
        seen.add(key)

        record = {**match, "input_sentence": sentence, "input_section": SECTION}
        record["input_offset"] = {
            **{k: v for k, v in old_offset.items() if k not in ("chunk_start", "chunk_end")},
            "start": start,
            "end": end,
            "length": end - start,
            "section": SECTION,
            "block_id": block_at_offset(document, start),
        }
        carried.append(record)
    return carried


# --- matching the changed text ----------------------------------------------------

def previous_source_papers(report: dict[str, Any]) -> list[dict[str, Any]]:
    """The previous report's sources, in load_candidate_chunks' paper shape.
    Their chunks come from this server's disk or, failing that, the paper store;
    a source with chunks in neither simply yields none."""
    from quick_check import _paper_ids_by_title

    papers: dict[str, dict[str, Any]] = {}
    titles_without_id: dict[str, dict[str, Any]] = {}
    for m in report.get("matches") or []:
        meta = {
            "title": m.get("source_title") or "",
            "url": m.get("source_url") or "",
            "pdf_url": m.get("source_pdf_url") or "",
            "source_kind": m.get("source_kind") or "academic",
            "authors": m.get("source_authors") or [],
            "year": m.get("source_year") or "",
            "doi": m.get("source_doi") or "",
        }
        if m.get("source_paper_id"):
            papers.setdefault(m["source_paper_id"], {"paper_id": m["source_paper_id"], **meta})
        elif meta["title"]:
            titles_without_id.setdefault(meta["title"], meta)
    for title, paper_id in _paper_ids_by_title(set(titles_without_id)).items():
        papers.setdefault(paper_id, {"paper_id": paper_id, **titles_without_id[title]})
    return list(papers.values())


def _search_queries(changed_text: str) -> list[str]:
    from doan_van import build_metadata_section_texts
    from llm_metadata import (
        build_queries_from_section_metadata,
        extract_all_section_metadata,
        extract_all_section_metadata_gemini,
        is_gemini_metadata_extraction_enabled,
    )

    section_texts = build_metadata_section_texts(changed_text)
    try:
        metadata = (
            extract_all_section_metadata_gemini(section_texts)
            if is_gemini_metadata_extraction_enabled()
            else extract_all_section_metadata(section_texts)
        )
        queries = build_queries_from_section_metadata(metadata)
    except Exception:
        logger.exception("Re-check metadata extraction failed; searching with the raw text")
        queries = []
    return queries or [changed_text[:300]]


def match_changed_text(
    document: dict[str, Any],
    runs: list[tuple[int, int]],
    previous_report: dict[str, Any],
    progress_callback: Optional[ProgressCallback] = None,
) -> dict[str, Any]:
    """
    The full pipeline over the changed runs only. Returns the
    build_final_report output for those chunks (records carry offsets into
    the whole edited document) plus `queries` and `coverage`.
    """
    from extractor import build_chunks_from_sections, build_weighted_sections
    from final_report_builder import build_final_report
    from paper_cache import cache_candidate_papers
    from plagiarism_matcher import load_candidate_chunks, match_chunks
    from search_paper.search_sources import search_all_sources
    from sentence_matcher import verify_all_matches
    from similarity import rank_papers
    from cited_sources import filter_cited_matches

    text = document["text"]
    sections = {f"changed_{i}": text[s:e] for i, (s, e) in enumerate(runs)}
    offsets = {f"changed_{i}": s for i, (s, _e) in enumerate(runs)}
    input_chunks = build_chunks_from_sections(sections, paper_id="input_recheck", section_offsets=offsets)
    changed_text = "\n\n".join(sections.values())

    empty = {"matches": [], "queries": [], "cited_sources": [],
             "coverage": {"total_candidate_papers": 0, "checked_papers": 0, "unavailable_papers": 0,
                          "status": "nothing_to_search"}}
    if not input_chunks:
        # Changed text too short to chunk (a few words); nothing to search.
        return empty

    _emit(progress_callback, 20, "metadata_extraction", "Reading the changed paragraphs")
    queries = _search_queries(changed_text)

    _emit(progress_callback, 35, "searching", "Searching related academic papers")
    candidates = search_all_sources(queries) or []

    cached_papers: list[dict[str, Any]] = []
    if candidates:
        _emit(progress_callback, 50, "ranking", "Ranking candidate papers")
        weighted = build_weighted_sections(title="", abstract=changed_text, introduction="",
                                           related_work="", method="", experiment="")
        ranked = rank_papers(weighted, candidates)
        _emit(progress_callback, 60, "downloading_sources", "Downloading and preparing source papers")
        cached_papers = cache_candidate_papers(ranked, top_k=min(10, len(ranked)), build_text=True)

    checked = sum(1 for p in cached_papers if p.get("downloaded") or p.get("num_chunks", 0) > 0)
    known_ids = {p.get("paper_id") for p in cached_papers}
    pool = cached_papers + [p for p in previous_source_papers(previous_report) if p["paper_id"] not in known_ids]
    candidate_chunks = load_candidate_chunks(pool)
    coverage = {
        "total_candidate_papers": len(cached_papers),
        "checked_papers": checked,
        "unavailable_papers": len(cached_papers) - checked,
        "status": "complete" if checked == len(cached_papers) else "partial",
    }
    if not candidate_chunks:
        return {**empty, "queries": queries, "coverage": coverage}

    _emit(progress_callback, 72, "chunk_matching", "Comparing the changed text with sources")
    matches = match_chunks(input_chunks=input_chunks, candidate_chunks=candidate_chunks,
                           top_k=3, similarity_threshold=0.75)

    source_metadata: dict[str, dict[str, Any]] = {}
    for m in matches:
        paper_id = m.get("source_paper_id")
        if paper_id and paper_id not in source_metadata:
            source_metadata[paper_id] = {
                "source_url": m.get("source_url", ""),
                "source_pdf_url": m.get("source_pdf_url", ""),
                "source_kind": m.get("source_kind", "academic"),
                "source_authors": m.get("source_authors", []),
                "source_year": m.get("source_year", ""),
                "source_doi": m.get("source_doi", ""),
            }

    _emit(progress_callback, 85, "sentence_matching", "Verifying sentence-level similarities")
    verified = verify_all_matches(matches)
    # Against the whole edited document, so its References still count.
    cited = filter_cited_matches(verified, document=document, input_text=text,
                                 source_metadata=source_metadata, matches=matches)

    partial = build_final_report(verified_matches=cited["kept"], input_chunks=input_chunks,
                                 input_text=text, document=document, source_metadata=source_metadata)
    for record in partial["matches"]:
        record["input_section"] = SECTION
        if record.get("input_offset"):
            record["input_offset"]["section"] = SECTION
    return {"matches": partial["matches"], "queries": queries,
            "cited_sources": cited["cited_sources"], "coverage": coverage}


# --- the whole re-check -------------------------------------------------------------

def merge_report(
    document: dict[str, Any],
    carried: list[dict[str, Any]],
    new: dict[str, Any],
    previous_report: dict[str, Any],
    changed: list[bool],
) -> dict[str, Any]:
    from document_model import LABEL_WEIGHT
    from cited_sources import reference_span
    from final_report_builder import (
        SCORING_VERSION, references_summary, coverage_score, drop_nested_duplicates, group_by_source,
        outside_references, sort_matches,
    )

    merged = list(carried)
    seen = {(m.get("source_paper_id") or m.get("source_title"), m["input_offset"]["start"], m["input_offset"]["end"])
            for m in carried}
    for m in new["matches"]:
        offset = m.get("input_offset") or {}
        key = (m.get("source_paper_id") or m.get("source_title"), offset.get("start"), offset.get("end"))
        if key not in seen:
            seen.add(key)
            merged.append(m)

    references = reference_span(document, document["text"])
    merged = drop_nested_duplicates(outside_references(merged, references))
    coverage = coverage_score(merged, document["total_chars"], references)
    ai_detection = previous_report.get("ai_detection")
    previous_coverage = previous_report.get("coverage") or {}

    cited_sources = list(previous_report.get("cited_sources") or [])
    cited_ids = {c.get("source_paper_id") for c in cited_sources}
    cited_sources += [c for c in new["cited_sources"] if c.get("source_paper_id") not in cited_ids]

    return {
        "overall_score": round(coverage["score"], 2),
        "total_input_chunks": previous_report.get("total_input_chunks", 0),
        "matched_papers": group_by_source(merged),
        "matches": sort_matches(merged),
        "input_text": document["text"],
        "scoring": {
            "version": SCORING_VERSION,
            "method": "weighted_char_coverage",
            "label_weights": dict(LABEL_WEIGHT),
            "total_chars": coverage["total_chars"],
            "matched_chars": coverage["matched_chars"],
            "covered_chars": coverage["covered_chars"],
            "raw_coverage_percent": coverage["raw_coverage"],
            "excluded_references": references_summary(references),
        },
        "document": {
            "version": document["version"],
            "total_chars": document["total_chars"],
            "sections": document["sections"],
            "blocks": document["blocks"],
            "text_field": "input_text",
        },
        "coverage": {**previous_coverage, **new["coverage"]} if new["coverage"]["status"] != "nothing_to_search"
        else previous_coverage,
        "queries": new["queries"] or previous_report.get("queries") or [],
        "cited_sources": cited_sources,
        "reference_list_found": previous_report.get("reference_list_found"),
        # Replaced by enrich() in run_recheck; kept (marked stale) if that fails.
        "ai_detection": {**ai_detection, "stale": True} if isinstance(ai_detection, dict) else ai_detection,
        "warnings": previous_report.get("warnings") or [],
        "recheck": {
            "changed_blocks": sum(changed),
            "total_blocks": len(changed),
            "carried_matches": len(carried),
            "new_matches": len(merged) - len(carried),
        },
    }


def run_recheck(
    previous_report: dict[str, Any],
    blocks: list[dict[str, Any]],
    passages: dict[str, dict[str, Any]],
    progress_callback: Optional[ProgressCallback] = None,
) -> dict[str, Any]:
    """
    Re-check the editor's `blocks` against `previous_report` (the last check:
    the local report JSON, or the newest document_checks.result). `passages`
    maps a block id to its stored document_passages row ({} when unknown).
    """
    _emit(progress_callback, 5, "preparing", "Finding the paragraphs you changed")
    previous_report = {**previous_report,
                       "matches": [report_match(m) for m in previous_report.get("matches") or []]}
    document, changed = build_edited_document(blocks, passages, previous_block_texts(previous_report))
    if not document["text"]:
        raise ValueError("The document is empty.")

    carried = carry_over_matches(previous_report.get("matches") or [], document, changed)
    runs = changed_runs(document, changed)
    new = match_changed_text(document, runs, previous_report, progress_callback) if runs else {
        "matches": [], "queries": [], "cited_sources": [],
        "coverage": {"status": "nothing_to_search"},
    }

    _emit(progress_callback, 94, "building_report", "Building the updated report")
    report = merge_report(document, carried, new, previous_report, changed)
    enrich(report, progress_callback)
    _emit(progress_callback, 100, "completed", "Re-check complete")
    return report


def enrich(report: dict[str, Any], progress_callback: Optional[ProgressCallback] = None) -> None:
    """AI detection + explanations for the re-checked text. Never raises."""
    from report_enrichment import enrich_report

    previous_ai = report.get("ai_detection")
    enrich_report(report, progress_callback, progress_points=(96, 98))
    fresh = report.get("ai_detection")
    if not (isinstance(fresh, dict) and fresh.get("available")) and isinstance(previous_ai, dict) and previous_ai.get("available"):
        report["ai_detection"] = previous_ai  # already marked stale


def ai_score(report: dict[str, Any]) -> Optional[float]:
    """The report's AI-writing score (0..100), or None when it has none."""
    detection = report.get("ai_detection")
    if not isinstance(detection, dict) or not detection.get("available") or detection.get("stale"):
        return None
    score = detection.get("overall_score")
    return float(score) if isinstance(score, (int, float)) else None
