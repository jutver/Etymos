"""
doan_van.py
-----------
Pipeline kiểm tra đạo văn cho một đoạn văn.

Dùng từ backend:
    from doan_van import check_text_plagiarism

    report = check_text_plagiarism(
        user_text="Đoạn văn cần kiểm tra...",
        progress_callback=callback
    )

Dùng từ terminal:
    python doan_van.py
    python doan_van.py "Đoạn văn cần kiểm tra..."
"""

from __future__ import annotations

import json
import os
import re
import sys
from typing import Any, Callable

from config import TOP_K


ProgressCallback = Callable[[int, str, str], None]


def normalize_input_text(text: str) -> str:
    """Chuẩn hóa khoảng trắng nhưng không lưu nội dung người dùng."""
    text = (text or "").strip()
    return re.sub(r"\s+", " ", text)


def build_input_sections(text: str) -> dict[str, str]:
    """
    Cấu trúc trung lập dùng cho chunk matching.
    Không khẳng định đoạn văn là abstract/method/introduction.
    """
    return {
        "title": "",
        "input_text": normalize_input_text(text),
    }


def build_metadata_section_texts(text: str) -> dict[str, str]:
    """
    Tái sử dụng API metadata theo section hiện tại.
    Đưa text vào title_abstract chỉ để tạo metadata/query tìm paper.
    """
    cleaned = normalize_input_text(text)

    return {
        "title_abstract": cleaned,
        "introduction": "",
        "related_work": "",
        "method": "",
        "experiment": "",
    }


def _emit_progress(
    callback: ProgressCallback | None,
    progress: int,
    step: str,
    message: str,
) -> None:
    if callback is None:
        return

    try:
        callback(
            progress=progress,
            step=step,
            message=message,
        )
    except TypeError:
        callback(progress, step, message)


def _empty_scoring(document: dict[str, Any]) -> dict[str, Any]:
    """`scoring` block for the early-return (0%) reports, so every report
    the API returns carries the same shape."""
    from document_model import LABEL_WEIGHT

    total = document.get("total_chars", 0)

    return {
        "version": 2,
        "method": "weighted_char_coverage",
        "label_weights": dict(LABEL_WEIGHT),
        "total_chars": total,
        "matched_chars": 0.0,
        "covered_chars": 0,
        "raw_coverage_percent": 0.0,
        "legacy_overall_score": 0.0,
        "legacy_total_chars": total,
    }


def _save_json(data: Any, path: str) -> None:
    directory = os.path.dirname(path)

    if directory:
        os.makedirs(directory, exist_ok=True)

    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def check_text_plagiarism(
    user_text: str,
    progress_callback: ProgressCallback | None = None,
    output_dir: str | None = None,
) -> dict[str, Any]:
    """
    Chạy toàn bộ pipeline kiểm tra đạo văn cho đoạn văn.

    progress_callback phải nhận:
        progress_callback(progress=int, step=str, message=str)

    Khi gọi từ API nên để output_dir=None để không lưu input/intermediate.
    """
    from document_model import build_document
    from extractor import (
        build_chunks_from_sections,
        build_weighted_sections,
    )
    from final_report_builder import build_final_report
    from llm_metadata import (
        build_queries_from_section_metadata,
        extract_all_section_metadata,
        extract_all_section_metadata_gemini,
        is_gemini_metadata_extraction_enabled,
    )
    from paper_cache import cache_candidate_papers
    from plagiarism_matcher import (
        load_candidate_chunks,
        match_chunks,
    )
    from search_paper.search_sources import search_all_sources
    from sentence_matcher import verify_all_matches
    from similarity import rank_papers

    cleaned_text = normalize_input_text(user_text)

    if len(cleaned_text) < 30:
        raise ValueError("Đoạn văn phải có ít nhất 30 ký tự.")

    _emit_progress(
        progress_callback,
        5,
        "preparing",
        "Preparing text analysis",
    )

    input_sections = build_input_sections(cleaned_text)
    metadata_section_texts = build_metadata_section_texts(cleaned_text)

    # Canonical document for the pasted-text path. With a single
    # non-empty section, document["text"] == cleaned_text, so existing
    # `input_text` consumers are unaffected — but chunks and matches now
    # carry absolute offsets into it, exactly as on the PDF path.
    document = build_document(input_sections)

    input_chunks = build_chunks_from_sections(
        input_sections,
        paper_id="input_text",
        chunk_size=900,
        overlap=150,
        section_offsets=document["section_offsets"],
    )

    if not input_chunks:
        raise ValueError("Không thể tạo chunk từ đoạn văn đầu vào.")

    weighted_sections = build_weighted_sections(
        title="",
        abstract=cleaned_text,
        introduction="",
        related_work="",
        method="",
        experiment="",
    )

    _emit_progress(
        progress_callback,
        15,
        "metadata_extraction",
        "Extracting metadata from input text",
    )

    use_gemini = is_gemini_metadata_extraction_enabled()
    section_metadata = (
        extract_all_section_metadata_gemini(metadata_section_texts)
        if use_gemini
        else extract_all_section_metadata(metadata_section_texts)
    )

    queries = build_queries_from_section_metadata(
        section_metadata
    )

    if not queries:
        queries = [cleaned_text[:300]]

    _emit_progress(
        progress_callback,
        35,
        "searching",
        "Searching related academic papers",
    )

    candidate_papers = search_all_sources(queries)

    if not candidate_papers:
        report = {
            "overall_score": 0.0,
            "total_input_chunks": len(input_chunks),
            "matched_papers": [],
            "matches": [],
            "input_text": cleaned_text,
            "scoring": _empty_scoring(document),
            "coverage": {
                "total_candidate_papers": 0,
                "checked_papers": 0,
                "unavailable_papers": 0,
                "status": "no_candidates",
            },
            "queries": queries,
            "warnings": [
                "No candidate papers were found. A 0% score is not a complete plagiarism conclusion."
            ],
        }

        _emit_progress(
            progress_callback,
            100,
            "completed",
            "Analysis complete with no candidate papers",
        )
        return report

    _emit_progress(
        progress_callback,
        48,
        "ranking",
        "Ranking candidate papers",
    )

    ranked_papers = rank_papers(
        weighted_sections,
        candidate_papers,
    )

    _emit_progress(
        progress_callback,
        60,
        "downloading_sources",
        "Downloading and preparing source papers",
    )

    cached_papers = cache_candidate_papers(
        ranked_papers,
        top_k=min(10, len(ranked_papers)),
        build_text=True,
    )

    checked_papers = sum(
        1
        for paper in cached_papers
        if paper.get("downloaded")
        or paper.get("num_chunks", 0) > 0
    )
    unavailable_papers = len(cached_papers) - checked_papers

    candidate_chunks = load_candidate_chunks(cached_papers)

    if not candidate_chunks:
        report = {
            "overall_score": 0.0,
            "total_input_chunks": len(input_chunks),
            "matched_papers": [],
            "matches": [],
            "input_text": cleaned_text,
            "scoring": _empty_scoring(document),
            "coverage": {
                "total_candidate_papers": len(cached_papers),
                "checked_papers": 0,
                "unavailable_papers": len(cached_papers),
                "status": "sources_unavailable",
            },
            "queries": queries,
            "warnings": [
                "Relevant papers were found, but no full text or candidate chunks were available. The 0% score is inconclusive."
            ],
        }

        _emit_progress(
            progress_callback,
            100,
            "completed",
            "Analysis complete but source full text was unavailable",
        )
        return report

    _emit_progress(
        progress_callback,
        72,
        "chunk_matching",
        "Comparing text with candidate paper chunks",
    )

    matches = match_chunks(
        input_chunks=input_chunks,
        candidate_chunks=candidate_chunks,
        top_k=5,
        similarity_threshold=0.82,
    )

    _emit_progress(
        progress_callback,
        85,
        "sentence_matching",
        "Verifying sentence-level similarities",
    )

    verified_matches = verify_all_matches(matches)

    _emit_progress(
        progress_callback,
        95,
        "building_report",
        "Building plagiarism report",
    )

    final_report = build_final_report(
        verified_matches=verified_matches,
        input_chunks=input_chunks,
        input_text=cleaned_text,
        document=document,
    )

    final_report["coverage"] = {
        "total_candidate_papers": len(cached_papers),
        "checked_papers": checked_papers,
        "unavailable_papers": unavailable_papers,
        "status": (
            "complete"
            if unavailable_papers == 0
            else "partial"
        ),
    }
    final_report["queries"] = queries

    # AI-content detection + plain-language explanations (additive, never
    # raises; progress values continue on from "building_report" at 95).
    from report_enrichment import enrich_report

    enrich_report(final_report, progress_callback, progress_points=(96, 98))

    warnings: list[str] = []

    if unavailable_papers > 0:
        warnings.append(
            f"{unavailable_papers} relevant paper(s) could not be fully checked because full text was unavailable."
        )

    final_report["warnings"] = warnings

    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

        _save_json(
            {
                "section_metadata": section_metadata,
                "queries": queries,
            },
            os.path.join(
                output_dir,
                "input_text_metadata.json",
            ),
        )
        _save_json(
            matches,
            os.path.join(
                output_dir,
                "text_plagiarism_matches.json",
            ),
        )
        _save_json(
            verified_matches,
            os.path.join(
                output_dir,
                "text_sentence_matches.json",
            ),
        )
        _save_json(
            final_report,
            os.path.join(
                output_dir,
                "final_report_text.json",
            ),
        )

    _emit_progress(
        progress_callback,
        100,
        "completed",
        "Analysis complete",
    )

    return final_report


def run_detection_from_text(
    text: str,
    output_dir: str | None = None,
    progress_callback: ProgressCallback | None = None,
) -> dict[str, Any]:
    """Alias giữ tương thích với code cũ."""
    return check_text_plagiarism(
        user_text=text,
        progress_callback=progress_callback,
        output_dir=output_dir,
    )


def read_multiline_input() -> str:
    print(
        "Dán đoạn văn cần kiểm tra. "
        "Kết thúc bằng một dòng trống hoặc Ctrl+D/Ctrl+Z:\n"
    )

    lines: list[str] = []

    try:
        while True:
            line = input()

            if line.strip() == "" and lines:
                break

            lines.append(line)

    except EOFError:
        pass

    return "\n".join(lines)


def print_verdict(report: dict[str, Any]) -> None:
    score = float(report.get("overall_score", 0.0))
    coverage = report.get("coverage", {})

    print("\n" + "=" * 80)
    print("KẾT QUẢ")
    print("=" * 80)
    print(f"Điểm trùng lặp tổng thể: {score:.2f}%")
    print(
        "Nguồn đã kiểm tra:",
        coverage.get("checked_papers", 0),
        "/",
        coverage.get("total_candidate_papers", 0),
    )

    if score >= 30:
        verdict = "Có dấu hiệu trùng lặp mạnh."
    elif score >= 10:
        verdict = "Có một số đoạn đáng nghi, cần xem lại."
    elif score > 0:
        verdict = "Chủ yếu ổn, có một số trùng lặp nhẹ."
    else:
        verdict = (
            "Không phát hiện trùng lặp "
            "trong các nguồn đã kiểm tra."
        )

    print(verdict)

    for warning in report.get("warnings", []):
        print("CẢNH BÁO:", warning)

    print("=" * 80)


def main() -> None:
    if len(sys.argv) > 1:
        text = " ".join(sys.argv[1:])
    else:
        text = read_multiline_input()

    if not text.strip():
        print("Bạn chưa nhập đoạn văn.")
        return

    def console_progress(
        progress: int,
        step: str,
        message: str,
    ) -> None:
        print(f"[{progress:3d}%] {step}: {message}")

    try:
        report = check_text_plagiarism(
            user_text=text,
            progress_callback=console_progress,
            output_dir="paper_cache",
        )
        print_verdict(report)

    except Exception as exc:
        print(f"\n[LỖI] {type(exc).__name__}: {exc}")


if __name__ == "__main__":
    main()
