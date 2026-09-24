"""
report_enrichment.py
--------------------
Post-processing applied to a finished plagiarism report, on every input path
(PDF, DOCX, pasted text):

  * AI-generated-content detection  -> report["ai_detection"]   (ai_detector.py)
  * plain-language explanations     -> match["explanation"]     (ai_explain.py)


Both are *additive*: the plagiarism score, matches and offsets are never
touched, each step is behind its own admin feature flag, and any failure is
logged and swallowed — enrichment must never fail or block the check that
produced the report.
"""

from __future__ import annotations

import logging

from feature_flags import ensure_flag_registered, is_flag_enabled

logger = logging.getLogger(__name__)

AI_DETECTION_FLAG_KEY = "ai_content_detection"
AI_EXPLANATIONS_FLAG_KEY = "ai_match_explanations"


def register_flags() -> None:
    """Make both toggles visible in the admin portal (default: on). Idempotent."""
    ensure_flag_registered(
        AI_DETECTION_FLAG_KEY,
        "AI-generated content detection",
        "Score each paragraph of a checked document for signs of machine-written text and "
        "show the result on the report. Uses the local language model on the GPU; turn off "
        "if checks become too slow.",
        default_enabled=True,
    )
    ensure_flag_registered(
        AI_EXPLANATIONS_FLAG_KEY,
        "AI polish for match explanations (experimental)",
        "Every match always gets a fact-based 'why is this flagged' explanation. When on, an LLM "
        "also rewrites the most serious ones more fluently (validated against the facts; a bad "
        "answer is discarded). Off by default: with the small local Qwen model the polished text "
        "was vaguer than the fact-based one and ~4s slower per match. Worth trying with Gemini.",
        default_enabled=False,
    )


def _emit(callback, progress: int, step: str, message: str) -> None:
    if callback is None:
        return
    try:
        callback(progress=progress, step=step, message=message)
    except Exception:  # noqa: BLE001 — progress reporting is best-effort
        logger.debug("progress callback failed", exc_info=True)


def _enabled(key: str, default: bool = True) -> bool:
    try:
        return is_flag_enabled(key, default=default)
    except Exception:  # noqa: BLE001
        logger.exception("Could not read feature flag %s; using its default (%s).", key, default)
        return default


def enrich_report(report: dict, progress_callback=None, *, progress_points: tuple[int, int] = (85, 92)) -> dict:
    """Add AI detection + better explanations to `report` in place. Never raises."""
    try:
        if _enabled(AI_DETECTION_FLAG_KEY):
            _emit(progress_callback, progress_points[0], "ai_detection", "Checking for AI-generated writing")
            from ai_detector import detect_ai_content

            report["ai_detection"] = detect_ai_content(report.get("document"), report.get("input_text") or "")
        else:
            report["ai_detection"] = {"available": False, "reason": "disabled by an administrator"}
    except Exception:  # noqa: BLE001
        logger.exception("AI-content detection step failed")
        report["ai_detection"] = {"available": False, "reason": "unexpected error"}

    try:
        matches = report.get("matches") or []
        if matches:
            _emit(progress_callback, progress_points[1], "explaining", "Writing plain-language explanations")
            from ai_explain import explain_matches

            # Fact-based explanations are unconditional; only the (experimental, default-off) LLM polish is behind the flag.
            report["explanations"] = explain_matches(matches, use_llm=_enabled(AI_EXPLANATIONS_FLAG_KEY, default=False))
    except Exception:  # noqa: BLE001
        logger.exception("Explanation step failed")

    return report
