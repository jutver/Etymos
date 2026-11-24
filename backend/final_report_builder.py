import json
from collections import defaultdict

from document_model import (
    LABEL_WEIGHT,
    block_at_offset,
    section_at_offset,
    weighted_coverage,
)
from search_paper.paper_identity import (
    canonical_paper_keys,
    classify_source_kind,
    normalized_title_key,
    strip_preprint_prefix,
)
from source_title import sanitize_source_title


SCORING_VERSION = 2


def _truncate(text, max_len=160):
    text = (text or "").strip()
    if len(text) <= max_len:
        return text
    return text[: max_len - 3].rstrip() + "..."


def _build_explanation(label, semantic_similarity, source_title, source_sentence):
    """
    Per-match, parameterized explanation string. Deliberately not another
    LLM call (none is cheaply available at this point in the pipeline,
    and the numbers already say something concrete) — but it must not be
    byte-identical across matches sharing a label the way the old
    frontend template (`Matched ${label}.`) was, so it always references
    this match's own similarity score, source, and excerpt.
    """
    label_text = (label or "match").replace("_", " ")
    similarity_pct = round((semantic_similarity or 0.0) * 100)
    title = (source_title or "").strip()
    excerpt = _truncate(source_sentence, 140)

    sentence = f"{similarity_pct}% semantic similarity"
    if title:
        sentence += f' to "{title}"'
    sentence += f" — classified as {label_text}."
    if excerpt:
        sentence += f' Matched source text: "{excerpt}"'

    return sentence


def coverage_score(matches, total_chars, excluded=None):
    """
    Weighted character coverage (see build_final_report's docstring) of
    final match records, from each record's `input_offset` and label.
    Records without offsets don't count. Shared by build_final_report and
    Save & re-check (recheck.py), so a re-checked document is scored by
    exactly the same formula as a fresh check.

    `excluded` is a [start, end) span (the reference list, see
    cited_sources.reference_span) left out of the score entirely: out of
    the total, and out of every match.
    """
    intervals = [
        (m["input_offset"]["start"], m["input_offset"]["end"], LABEL_WEIGHT.get(m.get("label"), 0))
        for m in matches
        if m.get("input_offset") and m["input_offset"].get("start") is not None
        and m["input_offset"].get("end") is not None
    ]
    if excluded:
        cut_start, cut_end = max(0, excluded[0]), min(excluded[1], total_chars)
        cut = max(0, cut_end - cut_start)
        kept = []
        for start, end, weight in intervals:
            # The part before the span stays; the part after it moves left
            # by the span's length, so positions stay inside the new total.
            if start < cut_start:
                kept.append((start, min(end, cut_start), weight))
            if end > cut_end:
                kept.append((max(start, cut_end) - cut, end - cut, weight))
        intervals = kept
        total_chars -= cut
    return weighted_coverage(intervals, total_chars)


def outside_references(matches, span):
    """The matches that aren't inside the reference list: an entry there
    names the paper it matches, so it is a citation, neither highlighted
    nor scored (like matches against cited sources, see cited_sources.py)."""
    if not span:
        return list(matches)
    start, end = span
    return [
        m for m in matches
        if not (
            (m.get("input_offset") or {}).get("start") is not None
            and m["input_offset"]["start"] >= start
            and m["input_offset"]["end"] <= end
        )
    ]


def _canonical_bucket_id(record, key_to_bucket):
    """Map a match record to a shared canonical bucket across all its keys
    (DOI, arXiv ID, ACL ID, normalized title, URL, or source_paper_id)."""
    keys = canonical_paper_keys(record)
    fallback = str(record.get("source_paper_id") or record.get("source_title") or "")
    if fallback:
        keys.append(f"id:{fallback}")
    bucket = next((key_to_bucket[k] for k in keys if k in key_to_bucket), None)
    if bucket is None:
        bucket = keys[0] if keys else fallback
    for k in keys:
        key_to_bucket.setdefault(k, bucket)
    return bucket


def group_by_source(matches):
    """`matched_papers`: final match records grouped per canonical source paper,
    strongest source first."""
    key_to_bucket = {}
    groups = defaultdict(lambda: {
        "source_paper_id": "",
        "source_title": "",
        "source_kind": "academic",
        "matches": [],
        "likely_count": 0,
        "suspicious_count": 0,
        "common_definition_count": 0,
        "max_similarity": 0.0
    })

    for record in matches:
        source_id = record.get("source_paper_id") or ""
        group_key = _canonical_bucket_id(record, key_to_bucket)
        group = groups[group_key]
        if not group["source_paper_id"] or (record.get("source_kind") == "academic" and group["source_kind"] != "academic"):
            group["source_paper_id"] = source_id
            group["source_title"] = record.get("source_title", "")
            group["source_kind"] = record.get("source_kind") or "academic"
        group["matches"].append(record)
        group["max_similarity"] = max(group["max_similarity"], record.get("semantic_similarity") or 0.0)

        label = record.get("label")
        if label == "likely_plagiarism":
            group["likely_count"] += 1
        elif label == "suspicious":
            group["suspicious_count"] += 1
        elif label == "common_academic_definition":
            group["common_definition_count"] += 1

    return sorted(
        groups.values(),
        key=lambda x: (
            x["likely_count"],
            x["suspicious_count"],
            x["max_similarity"]
        ),
        reverse=True
    )


def _merge_source_metadata(kept, dropped):
    """Preserve academic classification and richest bibliographic fields when
    unifying duplicate matches for the same canonical paper."""
    if dropped.get("source_kind") == "academic" and kept.get("source_kind") != "academic":
        kept["source_kind"] = "academic"
    if kept.get("source_title"):
        kept["source_title"] = sanitize_source_title(
            kept["source_title"],
            is_academic=(kept.get("source_kind") == "academic"),
        ) or kept["source_title"]
    for field in ("source_url", "source_pdf_url", "source_year", "source_doi"):
        if dropped.get(field) and not kept.get(field):
            kept[field] = dropped[field]
    if dropped.get("source_authors") and not kept.get("source_authors"):
        kept["source_authors"] = dropped["source_authors"]


def drop_nested_duplicates(matches):
    """
    Keep one match per canonical source for any input span: when two matches
    from the same canonical paper cover the same span, or one span lies inside
    the other, only the stronger one stays (with 'academic' taking precedence
    over 'web'). Overlapping chunks or duplicate web+academic hits used to
    yield duplicate cards for the same sentence.

    Matches from different canonical sources are left alone, and so are
    matches without offsets. Order is preserved.
    """
    def strength(m):
        offset = m["input_offset"]
        return (
            1 if m.get("source_kind") == "academic" else 0,
            LABEL_WEIGHT.get(m.get("label"), 0),
            offset["end"] - offset["start"],
            m.get("semantic_similarity") or 0,
        )

    key_to_bucket = {}
    kept_by_source = defaultdict(list)
    dropped = set()

    ranked = sorted(
        (i for i, m in enumerate(matches) if (m.get("input_offset") or {}).get("start") is not None),
        key=lambda i: strength(matches[i]),
        reverse=True,
    )

    for i in ranked:
        m = matches[i]
        start, end = m["input_offset"]["start"], m["input_offset"]["end"]
        source_key = _canonical_bucket_id(m, key_to_bucket)
        kept = kept_by_source[source_key]

        overlapping = next(
            (kept_match for s, e, kept_match in kept if (s <= start and end <= e) or (start <= s and e <= end)),
            None,
        )
        if overlapping is not None:
            _merge_source_metadata(overlapping, m)
            dropped.add(i)
            continue

        kept.append((start, end, m))

    return [m for i, m in enumerate(matches) if i not in dropped]


def _match_order_key(idx: int, m: dict) -> tuple:
    """Canonical top-to-bottom reading-order sort key for a match dict."""
    offset = m.get("input_offset") or {}
    start = offset.get("start")
    end = offset.get("end")
    sim = float(m.get("semantic_similarity") or 0.0)
    if start is not None:
        return (0, int(start), int(end) if end is not None else int(start), 0.0, -sim, idx)

    rects = m.get("pdf_rects")
    if isinstance(rects, list) and rects:
        valid = []
        for r in rects:
            if not isinstance(r, dict):
                continue
            page = r.get("page")
            y0 = r.get("y0")
            x0 = r.get("x0")
            if page is not None and y0 is not None and x0 is not None:
                try:
                    valid.append((int(page), round(float(y0), 1), round(float(x0), 1)))
                except (TypeError, ValueError):
                    continue
        if valid:
            p, y, x = min(valid)
            return (1, p, y, x, -sim, idx)

    return (2, 0, 0, 0.0, -sim, idx)


def sort_matches(matches):
    """Order matches top-to-bottom by document reading position, unlocated matches last."""
    return [
        m
        for _, m in sorted(
            enumerate(matches),
            key=lambda pair: _match_order_key(pair[0], pair[1]),
        )
    ]


def build_final_report(verified_matches, input_chunks, input_text=None, document=None,
                        source_metadata=None):
    """
    Assemble the final report.

    `document` is the canonical document from
    document_model.build_document(). When supplied:

      * every match carries `input_offset`, absolute character offsets
        into `report["input_text"]`, so the UI highlights the true span;
      * `overall_score` is computed from matched-character COVERAGE of
        the document rather than a sum of matched sentence lengths.

    Percentage formulas
    -------------------
    OLD (`legacy_overall_score`, kept for comparison):
        total   = Σ len(chunk.text) over all input chunks
        matched = Σ len(sentence) * LABEL_WEIGHT[label] over deduped matches
        score   = min(100, matched / total * 100)

      Two defects. (1) The denominator double-counts: chunks overlap by
      150 chars, so `total` exceeds the real document length and dilutes
      the score. (2) The numerator double-counts the other way: one
      sentence matching three source papers contributed its length three
      times, so heavily-reused prose could push the score far above the
      fraction of the document actually implicated.

    NEW (`overall_score`):
        total   = len(document.text)              # each char exactly once
        matched = Σ over the UNION of matched spans of
                  span_length * max(LABEL_WEIGHT of spans covering it)
        score   = min(100, matched / total * 100)

      A character can now contribute at most 1.0 to the numerator, and
      the denominator is the document the user actually sees. The score
      is therefore literally "the weighted share of this document that is
      implicated", and 100% requires the whole document to be matched.

      Expect reported percentages to MOVE, usually DOWN, for documents
      with many overlapping matches. See report["scoring"] for both
      numbers on every report.

    `source_metadata` (optional): dict keyed by source_paper_id ->
    {source_url, source_pdf_url, source_kind, source_authors, source_year,
    source_doi}. sentence_matcher.verify_all_matches() (not owned by this
    module) only forwards source_paper_id/source_title onto each
    `verified_matches` item, dropping the richer metadata match_chunks()
    attached to its own output — the caller (main.py) builds this lookup
    from that earlier `matches` list (keyed by source_paper_id) and passes
    it through here so every match record can still carry real
    author/year/url data for a later citation-formatting task
    (citations.py's format_reference()) without this module needing to
    reach into sentence_matcher's internals.
    """
    source_metadata = source_metadata or {}
    if input_text is None:
        if document is not None:
            input_text = document.get("text", "")
        else:
            input_text = " ".join(
                chunk.get("text", "") for chunk in input_chunks if isinstance(chunk, dict)
            ).strip()

    # Legacy denominator, retained only to compute legacy_overall_score.
    legacy_total_chars = sum(len(c.get("text", "")) for c in input_chunks)
    legacy_matched_chars = 0.0

    document_total_chars = (
        document.get("total_chars", len(input_text)) if document else len(input_text)
    )

    # (start, end, weight) spans feeding the new coverage-based score.
    coverage_intervals = []

    final_matches = []

    seen = set()
    # Secondary dedupe on absolute document coordinates: overlapping
    # chunks (150-char overlap) make the same sentence surface under two
    # different chunk_ids, which the chunk-keyed `seen` set cannot catch.
    seen_spans = set()

    for item in verified_matches:
        source_id = item["source_paper_id"]

        for sm in item["sentence_matches"]:
            key = (
                item["input_chunk_id"],
                source_id,
                sm["input_sentence_index"],
                sm["source_sentence_index"]
            )

            if key in seen:
                continue

            seen.add(key)

            doc_start = sm.get("input_doc_start")
            doc_end = sm.get("input_doc_end")

            if doc_start is not None:
                span_key = (source_id, doc_start, doc_end, sm["source_sentence"])
                if span_key in seen_spans:
                    continue
                seen_spans.add(span_key)

            label = sm["label"]
            weight = LABEL_WEIGHT.get(label, 0)

            char_len = len(sm["input_sentence"])
            legacy_matched_chars += char_len * weight

            if doc_start is not None and doc_end is not None:
                coverage_intervals.append((doc_start, doc_end, weight))

            source_title = item.get("source_title", "")
            meta = source_metadata.get(source_id) or {}
            source_url = meta.get("source_url", "")
            source_pdf_url = meta.get("source_pdf_url", "")
            source_doi = meta.get("source_doi", "")
            source_kind = classify_source_kind({
                "source_kind": meta.get("source_kind", "academic"),
                "source_url": source_url,
                "source_pdf_url": source_pdf_url,
                "source_doi": source_doi,
                "source_title": source_title,
            })
            if source_title:
                source_title = sanitize_source_title(
                    source_title,
                    is_academic=(source_kind == "academic"),
                ) or source_title

            record = {
                "label": label,
                "input_section": item["input_section"],
                "source_paper_id": source_id,
                "source_title": source_title,
                "source_section": item["source_section"],
                "input_chunk_id": item["input_chunk_id"],
                "source_chunk_id": item["source_chunk_id"],
                "input_sentence": sm["input_sentence"],
                "source_sentence": sm["source_sentence"],
                "semantic_similarity": sm["semantic_similarity"],
                "word_overlap": sm["word_overlap"],
                "char_ngram_overlap": sm["char_ngram_overlap"],
                # Per-match, parameterized text — see _build_explanation's
                # docstring for why this replaced a hardcoded
                # label-only template.
                "explanation": _build_explanation(
                    label, sm["semantic_similarity"], source_title, sm["source_sentence"]
                ),
                # Real source metadata (when known), enough to feed
                # citations.py's format_reference() later: {authors, year,
                # title, url}. Never built into an actual citation string
                # here — that UI/formatting is a separate, later task.
                "source_url": source_url,
                "source_pdf_url": source_pdf_url,
                "source_kind": source_kind,
                "source_authors": meta.get("source_authors", []),
                "source_year": meta.get("source_year", ""),
                "source_doi": source_doi,
            }

            if doc_start is not None and doc_end is not None:
                record["input_offset"] = {
                    "start": doc_start,
                    "end": doc_end,
                    "length": doc_end - doc_start,
                    "section": (
                        section_at_offset(document, doc_start)
                        if document else item["input_section"]
                    ),
                    "block_id": block_at_offset(document, doc_start) if document else None,
                    "chunk_id": item["input_chunk_id"],
                    "chunk_start": sm.get("input_chunk_start"),
                    "chunk_end": sm.get("input_chunk_end"),
                }

            if sm.get("source_chunk_start") is not None:
                record["source_offset"] = {
                    "chunk_id": item["source_chunk_id"],
                    "chunk_start": sm["source_chunk_start"],
                    "chunk_end": sm["source_chunk_end"],
                    "length": sm["source_chunk_end"] - sm["source_chunk_start"],
                }

            final_matches.append(record)

    legacy_overall_score = 0.0
    if legacy_total_chars > 0:
        legacy_overall_score = min(
            100.0, legacy_matched_chars / legacy_total_chars * 100
        )

    # The reference list is left out of the score (see coverage_score).
    from cited_sources import reference_span

    references = reference_span(document, input_text) if document is not None else None
    final_matches = outside_references(final_matches, references)
    final_matches = drop_nested_duplicates(final_matches)
    coverage = coverage_score(final_matches, document_total_chars, references)

    # Use the coverage score whenever we have real offsets to compute it
    # from. Without a document (a caller that hasn't been migrated yet)
    # there are no intervals, and falling back to the legacy number is
    # far better than silently reporting 0%.
    if coverage_intervals:
        overall_score = coverage["score"]
        scoring_method = "weighted_char_coverage"
    else:
        overall_score = legacy_overall_score
        scoring_method = "legacy_weighted_sentence_sum"

    matched_papers = group_by_source(final_matches)
    final_matches = sort_matches(final_matches)
    published_paper_match = detect_published_paper_match(
        final_matches,
        document=document,
        input_text=input_text,
        document_total_chars=document_total_chars,
        references=references,
    )

    report = {
        "overall_score": round(overall_score, 2),
        "total_input_chunks": len(input_chunks),
        "matched_papers": matched_papers,
        "matches": final_matches,
        "input_text": input_text or "",
        "scoring": {
            "version": SCORING_VERSION,
            "method": scoring_method,
            "label_weights": dict(LABEL_WEIGHT),
            "total_chars": coverage["total_chars"],
            "matched_chars": coverage["matched_chars"],
            "covered_chars": coverage["covered_chars"],
            "raw_coverage_percent": coverage["raw_coverage"],
            "excluded_references": references_summary(references),
            "legacy_overall_score": round(legacy_overall_score, 2),
            "legacy_total_chars": legacy_total_chars,
        },
    }
    if published_paper_match is not None:
        report["published_paper_match"] = published_paper_match

    if document is not None:
        # The document text itself is already returned as `input_text`;
        # only the structure is duplicated here.
        report["document"] = {
            "version": document.get("version"),
            "total_chars": document.get("total_chars", 0),
            "sections": document.get("sections", []),
            "blocks": document.get("blocks", []),
            "text_field": "input_text",
        }
        if document.get("extraction_meta") is not None:
            report["document"]["extraction_meta"] = document["extraction_meta"]

    return report


def _extract_document_title(document, input_text):
    """Best-effort title from the structured document or first non-empty line."""
    if document:
        for sec in document.get("sections") or []:
            if (sec.get("section") or sec.get("name")) == "title":
                if sec.get("text"):
                    return str(sec["text"]).strip()
                start, end = sec.get("start"), sec.get("end")
                if start is not None and end is not None and input_text:
                    return input_text[start:end].strip()
        for blk in document.get("blocks") or []:
            if blk.get("type") in ("title", "heading") and blk.get("text"):
                return str(blk["text"]).strip()
    if input_text:
        for line in input_text.splitlines():
            stripped = line.strip()
            if len(stripped) >= 12:
                return stripped[:240]
    return ""


def _titles_match(doc_title, source_title):
    """True when the uploaded document's title clearly matches the source title."""
    a = normalized_title_key(doc_title)
    b = normalized_title_key(source_title)
    if len(a) < 12 or len(b) < 12:
        return False
    if a == b or a.startswith(b) or b.startswith(a):
        return True
    words_a = set(a.split())
    words_b = set(b.split())
    if not words_a or not words_b:
        return False
    return (len(words_a & words_b) / len(words_a | words_b)) >= 0.80


def detect_published_paper_match(
    final_matches,
    *,
    document=None,
    input_text="",
    document_total_chars=0,
    references=None,
):
    """Identify when the uploaded document as a whole appears to be a single
    already published academic paper rather than an original draft."""
    if not final_matches or document_total_chars <= 0:
        return None

    key_to_bucket = {}
    by_paper = defaultdict(list)
    for m in final_matches:
        if m.get("source_kind") != "academic":
            continue
        key = _canonical_bucket_id(m, key_to_bucket)
        if key:
            by_paper[key].append(m)

    if not by_paper:
        return None

    doc_title = _extract_document_title(document, input_text)
    best = None

    for source_matches in by_paper.values():
        rep = source_matches[0]
        title = (rep.get("source_title") or "").strip()
        if not title:
            continue
        cov = coverage_score(source_matches, document_total_chars, references)
        raw_pct = float(cov.get("raw_coverage") or 0.0)
        title_matched = _titles_match(doc_title, title)
        if not (
            (raw_pct >= 50.0 and len(source_matches) >= 3)
            or (title_matched and raw_pct >= 25.0 and len(source_matches) >= 2)
        ):
            continue
        candidate = (raw_pct, title_matched, len(source_matches), rep)
        if best is None or candidate[:3] > best[:3]:
            best = candidate

    if best is None:
        return None

    raw_pct, title_matched, _, rep = best
    return {
        "detected": True,
        "source_paper_id": rep.get("source_paper_id") or "",
        "source_title": (rep.get("source_title") or "").strip(),
        "source_authors": list(rep.get("source_authors") or []),
        "source_year": str(rep.get("source_year") or ""),
        "source_url": rep.get("source_url") or rep.get("source_pdf_url") or "",
        "source_doi": rep.get("source_doi") or "",
        "coverage_percent": round(min(100.0, raw_pct), 2),
        "title_matched": bool(title_matched),
    }


def references_summary(span):
    """The reference list's span as saved in report["scoring"], or None."""
    if not span:
        return None
    return {"start": span[0], "end": span[1], "chars": span[1] - span[0]}


def save_final_report(report, output_path):
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)


def print_final_report(report, top_k=10):
    print("\n===== FINAL PLAGIARISM REPORT =====")
    print("Overall score:", report["overall_score"], "%")
    print("Total input chunks:", report["total_input_chunks"])

    print("\n===== MATCHED PAPERS =====")
    for paper in report["matched_papers"]:
        print(
            paper["source_paper_id"],
            "| likely:",
            paper["likely_count"],
            "| suspicious:",
            paper["suspicious_count"],
            "| common:",
            paper["common_definition_count"],
            "| max:",
            round(paper["max_similarity"], 4)
        )

    print("\n===== TOP MATCHES =====")
    for i, m in enumerate(report["matches"][:top_k], 1):
        print(f"\n{i}. {m['label']} | {m['semantic_similarity']:.4f}")
        print("Section:", m["input_section"])
        print("Source:", m["source_paper_id"])
        print("INPUT:", m["input_sentence"][:300])
        print("SOURCE:", m["source_sentence"][:300])