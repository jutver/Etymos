import os
from pathlib import Path

from config import TOP_K
from extractor import (
    extract_structured_sections_from_pdf,
    flatten_structured_sections,
    build_weighted_sections,
    debug_font_lines,
    build_heading_candidates,
    extract_lines_from_pdf,
    build_chunks_from_sections
)
from llm_metadata import (
    extract_all_section_metadata,
    extract_all_section_metadata_gemini,
    is_gemini_metadata_extraction_enabled,
    build_queries_from_section_metadata
)
from document_model import build_document
from search_paper.search_sources import search_all_sources
from similarity import rank_papers
from report import print_report
import json
from paper_cache import cache_candidate_papers
from plagiarism_matcher import (
    load_candidate_chunks,
    match_chunks,
    save_matches,
    print_matches
)
from sentence_matcher import (
    verify_all_matches,
    save_verified_matches,
    print_verified_matches
)
from final_report_builder import (
    build_final_report,
    save_final_report,
    print_final_report
)

# Intermediate cache directory for match/report JSON dumps written during a
# run. Previously hardcoded to a Google Colab Drive mount
# (/content/drive/MyDrive/Check_Dao_Van/paper_cache) which doesn't exist off
# Colab and crashes on the VPS. Same configurable-path pattern as
# backend/api/report_store.py's REPORT_DIR.
PAPER_CACHE_DIR = Path(os.getenv(
    "PAPER_CACHE_DIR",
    "/content/drive/MyDrive/Check_Dao_Van/paper_cache"
    if os.path.exists("/content/drive/MyDrive") else "./paper_cache"
))
PAPER_CACHE_DIR.mkdir(parents=True, exist_ok=True)


def check_pdf_plagiarism(pdf_path, progress_callback=None):
    if progress_callback:
        progress_callback(
            progress=5,
            step="preparing",
            message="Preparing document analysis"
        )

    print("\nBuilding heading candidates...")
    lines = extract_lines_from_pdf(pdf_path)
    candidates = build_heading_candidates(lines)
    heading_texts = [c["text"] for c in candidates]

    print("\n===== HEADING CANDIDATES =====")
    for h in heading_texts:
        print("-", h)


        if progress_callback:
          progress_callback(
              progress=10,
              step="extracting",
              message="Extracting sections from PDF"
          )
    # Structured extraction is the single source of truth: `sections` (flat
    # strings, for the matching/chunking pipeline below) is derived from the
    # exact same blocks that get attached to `document["blocks"]` for the
    # Document view, so nothing can drift between "what got matched" and
    # "what the user sees". See extractor.extract_structured_sections_from_pdf.
    structured = extract_structured_sections_from_pdf(pdf_path)
    sections = flatten_structured_sections(structured)

    title = sections.get("title", "")
    abstract = sections.get("abstract", "")
    introduction = sections.get("introduction", "")
    related_work = sections.get("related_work", "")
    method = sections.get("method", "")
    experiment = sections.get("experiment", "")

    section_texts = {
        "title_abstract": title + "\n" + abstract,
        "introduction": introduction,
        "related_work": related_work,
        "method": method,
        "experiment": experiment
    }

    weighted_sections = build_weighted_sections(
        title=title,
        abstract=abstract,
        introduction=introduction,
        related_work=related_work,
        method=method,
        experiment=experiment
    )

    # Canonical, offset-addressable document. `document["text"]` is the
    # single coordinate system every match offset in the final report is
    # expressed in, and is returned to the client as `input_text`.
    #
    # NOTE: this now includes the `conclusion` section, which the old
    # manual join dropped even though conclusion chunks were always fed
    # to the matcher — a match in the conclusion previously had no text
    # to point at.
    document = build_document(sections, structured_sections=structured["sections"])
    input_text = document["text"]

    print("\n===== TITLE =====")
    print(title)

    print("\n===== ABSTRACT =====")
    print(abstract[:500])

    print("\n===== INTRODUCTION =====")
    print(introduction[:500])

    print("\n===== METHOD =====")
    print(method[:500])

    print("\n===== RELATED WORK =====")
    print(related_work[:500])

    print("\n===== EXPERIMENT =====")
    print(experiment[:500])

    return _run_matching_pipeline(
        sections=sections,
        document=document,
        input_text=input_text,
        weighted_sections=weighted_sections,
        section_texts=section_texts,
        progress_callback=progress_callback,
    )


def check_docx_plagiarism(docx_path, progress_callback=None):
    """
    .docx counterpart to check_pdf_plagiarism(). Extraction goes through
    extract_docx.extract_structured_sections_from_docx() instead of the
    PDF-specific font-size heuristics, but from `sections`/`document`
    onward this runs the exact same matching pipeline (_run_matching_pipeline)
    as the PDF path, so scoring/offsets/report shape are identical.

    .docx documents essentially never carry the abstract/introduction/
    method/... academic-paper structure extract_sections_from_pdf() looks
    for (see extract_docx.py's module docstring), so there is no
    per-section weighting to compute here — the whole document goes into
    one "title_abstract"-keyed bucket for query building, and one "body"
    section for chunking/matching. Search relevance for non-academic
    content (a brand audit, a Vietnamese report) is inherently weaker than
    for an actual paper matched against the academic-paper search sources
    this pipeline was built for — a product-scope limitation, not a bug
    introduced here.
    """
    from extract_docx import extract_structured_sections_from_docx

    if progress_callback:
        progress_callback(
            progress=5,
            step="preparing",
            message="Preparing document analysis"
        )

    if progress_callback:
        progress_callback(
            progress=10,
            step="extracting",
            message="Extracting content from document"
        )

    structured = extract_structured_sections_from_docx(docx_path)
    sections = flatten_structured_sections(structured)

    title = sections.get("title", "")
    body = sections.get("body", "")

    section_texts = {
        # First ~800 chars of body stands in for an abstract — .docx
        # documents don't have one, but extract_all_section_metadata's
        # prompt for "title_abstract" is the only bucket worth spending an
        # LLM call on for a generic document; the other four *academic*
        # target sections (introduction/related_work/method/experiment)
        # are left empty and short-circuit to normalize_metadata({}) with
        # no crash (see llm_metadata.extract_section_metadata_with_llm).
        "title_abstract": (title + "\n" + body[:800]).strip(),
    }

    weighted_sections = {
        "title_abstract": {"text": title + "\n" + body[:800], "weight": 1.0},
        "body": {"text": body, "weight": 0.8},
    }

    # A .docx document has no method/experiment/related-work structure to
    # bucket into, so title_abstract alone was every query this pipeline
    # ever generated for it — 4 of 5 query-generating LLM calls did
    # nothing, and a long document's middle/end content never contributed
    # a single search query regardless of how much it differed from the
    # opening 800 chars. Split the remaining body into thirds and give
    # each a metadata-extraction + query-building bucket of its own.
    # llm_metadata.extract_all_section_metadata[_gemini] and
    # build_queries_from_section_metadata both process any extra keys
    # beyond the standard academic five, so these just ride along the
    # existing pipeline. Named "body_partN" (not standard section names)
    # so they're unambiguously "extra" there.
    body_len = len(body)
    third = body_len // 3
    body_parts = [body[:third], body[third:2 * third], body[2 * third:]] if third > 0 else [body]

    for index, part in enumerate(body_parts):
        if len(part.strip()) < 50:
            continue
        key = f"body_part{index + 1}"
        section_texts[key] = part
        weighted_sections[key] = {"text": part, "weight": 0.6}

    document = build_document(sections, structured_sections=structured["sections"])
    input_text = document["text"]

    print("\n===== TITLE =====")
    print(title)
    print("\n===== BODY (first 500 chars) =====")
    print(body[:500])

    return _run_matching_pipeline(
        sections=sections,
        document=document,
        input_text=input_text,
        weighted_sections=weighted_sections,
        section_texts=section_texts,
        progress_callback=progress_callback,
    )


def _run_matching_pipeline(*, sections, document, input_text, weighted_sections,
                            section_texts, progress_callback=None):
    """
    Shared tail of check_pdf_plagiarism()/check_docx_plagiarism(): metadata
    extraction -> query building -> source search -> chunking -> matching
    -> final report. Extraction-format-agnostic; everything it touches
    (`sections`, `document`, `weighted_sections`, `section_texts`) is
    already normalized to the same shape by both callers.
    """
    if progress_callback:
      progress_callback(
          progress=25,
          step="metadata_extraction",
          message="Extracting academic metadata"
      )
    use_gemini = is_gemini_metadata_extraction_enabled()
    print(f"\nExtracting section metadata with {'Gemini' if use_gemini else 'local LLM'}...")
    section_metadata = (
        extract_all_section_metadata_gemini(section_texts)
        if use_gemini
        else extract_all_section_metadata(section_texts)
    )

    print("\n===== SECTION JSON METADATA =====")
    for section_name, metadata in section_metadata.items():
        print(f"\n--- {section_name.upper()} ---")
        print(json.dumps(metadata, indent=2, ensure_ascii=False))

    # Tạm thời dùng title_abstract metadata để build query chính
    main_metadata = section_metadata.get("title_abstract", {})
    queries = build_queries_from_section_metadata(section_metadata)

    if progress_callback:
      progress_callback(
          progress=40,
          step="searching",
          message="Searching related academic papers"
      )

    print("\n===== QUERIES =====")
    for q in queries:
        print("-", q)

    print("\nSearching all sources...")
    candidate_papers = search_all_sources(queries)

    # print("\nTOTAL CANDIDATES:", len(candidate_papers))

    print("\nRanking papers with weighted sections...")
    results = rank_papers(
        weighted_sections,
        candidate_papers
    )

    print_report(results, top_k=TOP_K)

    print("\nCaching candidate papers...")
    cached_papers = cache_candidate_papers(
        # Was top_k=10: only the top 10 ranked candidates ever got
        # chunked/matched at all, which was a major contributor to sparse
        # matches ("only checks paper, not web") — most DuckDuckGo web
        # results never survived to the matching stage regardless of how
        # relevant they were. Raised to 25 to catch more sources without
        # the runtime blowing up (each extra candidate is at most one PDF
        # download + a handful of embeddings, not a new search round).
        results,
        top_k=25
      )

    input_chunks = build_chunks_from_sections(
        sections,
        paper_id="input_paper",
        section_offsets=document["section_offsets"]
    )

    candidate_chunks = load_candidate_chunks(cached_papers)

    matches = match_chunks(
        input_chunks=input_chunks,
        candidate_chunks=candidate_chunks,
        top_k=3,
        # Was 0.82 — a strict cosine threshold that was very likely the
        # single biggest cause of "sometimes catch very less source": a
        # genuinely paraphrased or partially-copied passage often scores
        # well below 0.82 on semantic similarity alone even though
        # word/char n-gram overlap (checked downstream in classify_match)
        # would flag it. Lowered to 0.75; classify_match's own higher
        # semantic+overlap thresholds (0.86/0.90) still gate what actually
        # counts as "suspicious"/"likely_plagiarism", so this only widens
        # the candidate pool considered, not the final labeling.
        similarity_threshold=0.75
    )

    # sentence_matcher.verify_all_matches() (not owned by this task) only
    # forwards source_paper_id/source_title onto each verified-match item,
    # dropping the richer per-source metadata match_chunks() just attached
    # above (source_url/source_kind/source_authors/source_year/source_doi).
    # Build a paper_id -> metadata lookup from `matches` (this function's
    # own output, before it goes through verify_all_matches) so
    # final_report_builder.build_final_report can still attach real
    # author/year/url data to every match record without needing changes
    # to sentence_matcher.py.
    source_metadata_by_paper_id = {}
    for m in matches:
        paper_id = m.get("source_paper_id")
        if paper_id and paper_id not in source_metadata_by_paper_id:
            source_metadata_by_paper_id[paper_id] = {
                "source_url": m.get("source_url", ""),
                "source_pdf_url": m.get("source_pdf_url", ""),
                "source_kind": m.get("source_kind", "academic"),
                "source_authors": m.get("source_authors", []),
                "source_year": m.get("source_year", ""),
                "source_doi": m.get("source_doi", ""),
            }

    save_matches(
        matches,
        str(PAPER_CACHE_DIR / "plagiarism_matches.json")
    )

    print_matches(matches, top_k=20)

    verified_matches = verify_all_matches(matches)

    save_verified_matches(
        verified_matches,
        str(PAPER_CACHE_DIR / "sentence_matches.json")
    )

    print_verified_matches(verified_matches, top_k=10)

    final_report = build_final_report(
        verified_matches=verified_matches,
        input_chunks=input_chunks,
        input_text=input_text,
        document=document,
        source_metadata=source_metadata_by_paper_id,
    )

    try:
        # Best-effort debug/cache artifact only — not required for the API
        # response. Image blocks in document["blocks"] still carry raw
        # `_image_bytes`/`_image_ext` at this point (stripped later, in
        # report_store.py's save_report(), which the caller runs on this
        # same `final_report` object to actually upload images to Supabase
        # Storage) — so this write must strip them from a COPY, never the
        # real object, or report_store.py would lose the bytes it needs to
        # upload images. Copying lets this debug write actually succeed
        # instead of always silently failing on every document that has an
        # extracted image (i.e. most real documents now). The try/except
        # stays as a final backstop so an unrelated write error still can't
        # take down the whole check.
        blocks = final_report.get("document", {}).get("blocks")
        debug_report = final_report
        if blocks:
            debug_report = {
                **final_report,
                "document": {
                    **final_report["document"],
                    "blocks": [
                        {k: v for k, v in b.items() if k not in ("_image_bytes", "_image_ext")}
                        for b in blocks
                    ],
                },
            }
        save_final_report(
            debug_report,
            str(PAPER_CACHE_DIR / "final_report.json")
        )
    except Exception:
        import traceback
        traceback.print_exc()

    print_final_report(final_report, top_k=10)

    print("\n===== CACHED PAPERS =====")
    for item in cached_papers:
        print(item)

    from collections import Counter

    counter = Counter()

    for item in verified_matches:
        for s in item["sentence_matches"]:
            counter[s["label"]] += 1

    if progress_callback:
      progress_callback(
          progress=100,
          step="completed",
          message="Analysis complete"
      )

    return final_report

if __name__ == "__main__":
    test_pdf = os.getenv("TEST_PDF_PATH", str(PAPER_CACHE_DIR / "VIHateT5.pdf"))

    def debug_progress(progress, step, message):
        print(f"[{progress}%] {step}: {message}")

    report = check_pdf_plagiarism(
        pdf_path=test_pdf,
        progress_callback=debug_progress
    )

    print(report)