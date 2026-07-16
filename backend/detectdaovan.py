"""
detectdoanvan.py
-----------------
Entry point đơn giản: paste một đoạn văn -> chạy toàn bộ pipeline check đạo văn
(dùng lại logic trong detectdaovan.py: extractor, llm_metadata, similarity,
plagiarism_matcher, sentence_matcher, final_report_builder).

Cách chạy:
    python detectdoanvan.py
    (paste đoạn văn, nhiều dòng cũng được, kết thúc bằng cách nhấn Enter
     ở một dòng trống, hoặc Ctrl+D trên Linux/Mac, Ctrl+Z rồi Enter trên Windows)

Hoặc:
    python detectdoanvan.py "đoạn văn của bạn ở đây..."

YÊU CẦU trước khi chạy được thật:
    - config.py                (đã có)
    - extractor.py              (đã có)
    - embedding_model.py        (đã có, cần internet để tải model lần đầu)
    - llm_metadata.py           (đã có, cần internet để tải Qwen2.5-1.5B lần đầu)
    - plagiarism_matcher.py, sentence_matcher.py, final_report_builder.py,
      similarity.py, report.py, paper_cache.py, detectdaovan.py  (đã có)
    - search_paper/search_sources.py  -> BẮT BUỘC PHẢI CÓ, hàm search_all_sources(queries)
      trả về list các paper candidate (title, abstract, year, doi, source, url, pdf_url...).
      File này CHƯA được cung cấp trong repo bạn upload -> pipeline sẽ lỗi ImportError
      nếu chưa có. Nếu bạn chưa có, nói mình biết để viết stub/kết nối API thật
      (OpenAlex / Semantic Scholar / arXiv / CORE) cho bạn.
"""

import os
import re
import sys
import json

from config import TOP_K


def normalize_input_text(text):
    text = (text or "").strip()
    return re.sub(r"\s+", " ", text)


def build_input_sections(text):
    """
    Treat the user's input as a single plain paragraph.
    We do not split it into title/abstract sections.
    """
    cleaned = normalize_input_text(text)

    if not cleaned:
        return {
            "title": "",
            "abstract": "",
            "introduction": "",
            "related_work": "",
            "method": "",
            "experiment": "",
            "conclusion": "",
        }

    return {
        "title": "",
        "abstract": cleaned,
        "introduction": "",
        "related_work": "",
        "method": "",
        "experiment": "",
        "conclusion": "",
    }


def build_input_section_texts(text):
    sections = build_input_sections(text)

    return {
        "title_abstract": sections.get("abstract", ""),
        "introduction": sections.get("introduction", ""),
        "related_work": sections.get("related_work", ""),
        "method": sections.get("method", ""),
        "experiment": sections.get("experiment", ""),
    }


def run_detection_from_text(text, output_dir="paper_cache"):
    from extractor import (
        build_weighted_sections,
        build_chunks_from_sections,
    )
    from llm_metadata import (
        extract_all_section_metadata,
        build_queries_from_section_metadata,
    )
    from search_paper.search_sources import search_all_sources
    from similarity import rank_papers
    from report import print_report
    from paper_cache import cache_candidate_papers
    from plagiarism_matcher import (
        load_candidate_chunks,
        match_chunks,
        save_matches,
        print_matches,
    )
    from sentence_matcher import (
        verify_all_matches,
        save_verified_matches,
        print_verified_matches,
    )
    from final_report_builder import (
        build_final_report,
        save_final_report,
        print_final_report,
    )

    cleaned_text = normalize_input_text(text)

    if not cleaned_text:
        raise ValueError("Vui lòng nhập đoạn văn cần kiểm tra.")

    os.makedirs(output_dir, exist_ok=True)

    sections = build_input_sections(cleaned_text)
    section_texts = build_input_section_texts(cleaned_text)

    weighted_sections = build_weighted_sections(
        title="",
        abstract=sections["abstract"],
        introduction=sections["introduction"],
        related_work=sections["related_work"],
        method=sections["method"],
        experiment=sections["experiment"],
    )

    input_chunks = build_chunks_from_sections(
        sections,
        paper_id="input_paper"
    )

    print("\n===== INPUT TEXT =====")
    print(cleaned_text[:1000])

    print("\nExtracting section metadata with LLM...")
    section_metadata = extract_all_section_metadata(section_texts)
    queries = build_queries_from_section_metadata(section_metadata)

    metadata_payload = {
        "input_text": cleaned_text,
        "section_metadata": section_metadata,
        "queries": queries,
    }

    metadata_path = os.path.join(output_dir, "input_text_metadata.json")
    with open(metadata_path, "w", encoding="utf-8") as f:
        json.dump(metadata_payload, f, ensure_ascii=False, indent=2)

    print("\n===== QUERIES =====")
    for q in queries:
        print("-", q)

    print("\nSearching all sources...")
    candidate_papers = search_all_sources(queries)

    print("\nRanking papers with weighted sections...")
    results = rank_papers(weighted_sections, candidate_papers)
    print_report(results, top_k=TOP_K)

    print("\nCaching candidate papers...")
    cached_papers = cache_candidate_papers(results, top_k=10)

    print("\n===== PDF DOWNLOAD STATUS =====")
    downloaded_count = 0
    for p in cached_papers:
        status = p.get("status")
        source_note = "abstract_fallback" if p.get("chunks_source") == "abstract_fallback" else "full_pdf"
        if p.get("downloaded"):
            downloaded_count += 1
        print(f"  [{status}] ({source_note}, {p.get('num_chunks', 0)} chunks) {p.get('title', '')[:60]}")
    print(f"-> {downloaded_count}/{len(cached_papers)} paper tải được full PDF; còn lại dùng abstract fallback để vẫn so khớp được.")

    candidate_chunks = load_candidate_chunks(cached_papers)

    matches = match_chunks(
        input_chunks=input_chunks,
        candidate_chunks=candidate_chunks,
        top_k=3,
        similarity_threshold=0.75,
    )

    save_matches(matches, os.path.join(output_dir, "plagiarism_matches.json"))
    print_matches(matches, top_k=20)

    verified_matches = verify_all_matches(matches)

    save_verified_matches(
        verified_matches,
        os.path.join(output_dir, "sentence_matches.json")
    )
    print_verified_matches(verified_matches, top_k=10)

    final_report = build_final_report(
        verified_matches=verified_matches,
        input_chunks=input_chunks,
    )

    save_final_report(
        final_report,
        os.path.join(output_dir, "final_report.json")
    )
    print_final_report(final_report, top_k=10)

    return {
        "input_text": cleaned_text,
        "metadata_path": metadata_path,
        "section_metadata": section_metadata,
        "queries": queries,
        "final_report": final_report,
    }


def read_multiline_input():
    """
    Đọc input nhiều dòng từ terminal.
    Kết thúc khi: gặp dòng trống (Enter 2 lần) hoặc EOF (Ctrl+D / Ctrl+Z).
    """
    print("Dán đoạn văn cần kiểm tra đạo văn (kết thúc bằng dòng trống hoặc Ctrl+D):\n")

    lines = []
    try:
        while True:
            line = input()
            if line.strip() == "" and lines:
                break
            lines.append(line)
    except EOFError:
        pass

    return "\n".join(lines)


def print_verdict(result):
    report = result["final_report"]
    score = report["overall_score"]

    print("\n" + "=" * 80)
    print("KẾT LUẬN")
    print("=" * 80)

    if score >= 30:
        verdict = "⚠️  CÓ DẤU HIỆU ĐẠO VĂN RÕ RÀNG"
    elif score >= 10:
        verdict = "⚠️  CÓ MỘT SỐ ĐOẠN NGHI VẤN, CẦN XEM LẠI"
    elif score > 0:
        verdict = "✅ CHỦ YẾU ỔN, VÀI ĐOẠN TRÙNG NHẸ / ĐỊNH NGHĨA CHUNG"
    else:
        verdict = "✅ KHÔNG PHÁT HIỆN ĐẠO VĂN"

    print(f"\nĐiểm trùng lặp tổng thể: {score}%")
    print(verdict)

    matched_papers = report.get("matched_papers", [])
    if matched_papers:
        print(f"\nSố nguồn liên quan: {len(matched_papers)}")
        for p in matched_papers[:5]:
            print(
                f"  - {p['source_title'][:80] or p['source_paper_id']} "
                f"| likely: {p['likely_count']} | suspicious: {p['suspicious_count']} "
                f"| max sim: {round(p['max_similarity'], 3)}"
            )
    else:
        print("\nKhông tìm thấy nguồn nào trùng đáng kể.")

    top_matches = report.get("matches", [])
    if top_matches:
        print("\nVí dụ câu trùng nổi bật nhất:")
        m = top_matches[0]
        print(f"  Label: {m['label']} | semantic: {m['semantic_similarity']:.3f}")
        print(f"  INPUT : {m['input_sentence'][:200]}")
        print(f"  SOURCE: {m['source_sentence'][:200]}")

    print("=" * 80)


def main():
    if len(sys.argv) > 1:
        text = " ".join(sys.argv[1:])
    else:
        text = read_multiline_input()

    if not text.strip():
        print("Bạn chưa nhập đoạn văn nào.")
        return

    try:
        result = run_detection_from_text(text)
    except ImportError as e:
        print("\n[LỖI] Thiếu module bắt buộc để chạy pipeline:")
        print(f"  {e}")
        print(
            "\nRất có thể bạn chưa có file search_paper/search_sources.py "
            "(hàm search_all_sources) — module này dùng để tìm paper ứng viên "
            "từ OpenAlex/Semantic Scholar/arXiv/CORE. Cần bổ sung file đó trước."
        )
        return

    print_verdict(result)


if __name__ == "__main__":
    main()