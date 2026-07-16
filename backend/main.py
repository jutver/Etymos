from config import TOP_K
from extractor import (
    extract_sections_from_pdf,
    build_weighted_sections,
    debug_font_lines,
    build_heading_candidates,
    extract_lines_from_pdf,
    build_chunks_from_sections
)
from llm_metadata import (
    extract_all_section_metadata,
    build_queries_from_section_metadata
)
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
    sections = extract_sections_from_pdf(pdf_path)
    sections = extract_sections_from_pdf(pdf_path)
    
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

    input_text = "\n\n".join(
        part for part in [title, abstract, introduction, related_work, method, experiment] if part and part.strip()
    )

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

    if progress_callback:
      progress_callback(
          progress=25,
          step="metadata_extraction",
          message="Extracting academic metadata"
      )
    section_metadata = extract_all_section_metadata(section_texts)
    print("\nExtracting section metadata with LLM...")
    section_metadata = extract_all_section_metadata(section_texts)


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
        top_k=10
      )

    input_chunks = build_chunks_from_sections(
        sections,
        paper_id="input_paper"
    )

    candidate_chunks = load_candidate_chunks(cached_papers)

    matches = match_chunks(
        input_chunks=input_chunks,
        candidate_chunks=candidate_chunks,
        top_k=3,
        similarity_threshold=0.82
    )

    save_matches(
        matches,
        "/content/drive/MyDrive/Check_Dao_Van/paper_cache/plagiarism_matches.json"
    )

    print_matches(matches, top_k=20)

    verified_matches = verify_all_matches(matches)

    save_verified_matches(
        verified_matches,
        "/content/drive/MyDrive/Check_Dao_Van/paper_cache/sentence_matches.json"
    )

    print_verified_matches(verified_matches, top_k=10)

    final_report = build_final_report(
        verified_matches=verified_matches,
        input_chunks=input_chunks,
        input_text=input_text,
    )

    save_final_report(
        final_report,
        "/content/drive/MyDrive/Check_Dao_Van/paper_cache/final_report.json"
    )

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
    test_pdf = "/content/drive/MyDrive/Check_Dao_Van/VIHateT5.pdf"

    def debug_progress(progress, step, message):
        print(f"[{progress}%] {step}: {message}")

    report = check_pdf_plagiarism(
        pdf_path=test_pdf,
        progress_callback=debug_progress
    )

    print(report)