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

        similarity_threshold=0.75
    )


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
    test_pdf = "C:\\Users\\trinh\\Downloads\\VIHateT5.pdf"
    def debug_progress(progress, step, message):
        print(f"[{progress}%] {step}: {message}")

    report = check_pdf_plagiarism(
        pdf_path=test_pdf,
        progress_callback=debug_progress
    )

    print(report)