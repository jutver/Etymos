import json
from collections import defaultdict

from document_model import (
    LABEL_WEIGHT,
    block_at_offset,
    section_at_offset,
    weighted_coverage,
)


SCORING_VERSION = 2


def build_final_report(verified_matches, input_chunks, input_text=None, document=None):
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
    """
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

    paper_groups = defaultdict(lambda: {
        "source_paper_id": "",
        "source_title": "",
        "matches": [],
        "likely_count": 0,
        "suspicious_count": 0,
        "common_definition_count": 0,
        "max_similarity": 0.0
    })

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

            record = {
                "label": label,
                "input_section": item["input_section"],
                "source_paper_id": source_id,
                "source_title": item.get("source_title", ""),
                "source_section": item["source_section"],
                "input_chunk_id": item["input_chunk_id"],
                "source_chunk_id": item["source_chunk_id"],
                "input_sentence": sm["input_sentence"],
                "source_sentence": sm["source_sentence"],
                "semantic_similarity": sm["semantic_similarity"],
                "word_overlap": sm["word_overlap"],
                "char_ngram_overlap": sm["char_ngram_overlap"]
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

            group = paper_groups[source_id]
            group["source_paper_id"] = source_id
            group["source_title"] = item.get("source_title", "")
            group["matches"].append(record)
            group["max_similarity"] = max(
                group["max_similarity"],
                sm["semantic_similarity"]
            )

            if label == "likely_plagiarism":
                group["likely_count"] += 1
            elif label == "suspicious":
                group["suspicious_count"] += 1
            elif label == "common_academic_definition":
                group["common_definition_count"] += 1

    legacy_overall_score = 0.0
    if legacy_total_chars > 0:
        legacy_overall_score = min(
            100.0, legacy_matched_chars / legacy_total_chars * 100
        )

    coverage = weighted_coverage(coverage_intervals, document_total_chars)

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

    matched_papers = sorted(
        paper_groups.values(),
        key=lambda x: (
            x["likely_count"],
            x["suspicious_count"],
            x["max_similarity"]
        ),
        reverse=True
    )

    final_matches = sorted(
        final_matches,
        key=lambda x: (
            x["label"] == "likely_plagiarism",
            x["semantic_similarity"]
        ),
        reverse=True
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
            "legacy_overall_score": round(legacy_overall_score, 2),
            "legacy_total_chars": legacy_total_chars,
        },
    }

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

    return report


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