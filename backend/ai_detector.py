"""
ai_detector.py
--------------
AI-generated-content detection, as a *signal* next to the plagiarism score
(it is deliberately not folded into `overall_score`).

Method (`lm_predictability_v1`)
-------------------------------
Language models write the words a language model finds likely. So a passage
that a reference LM finds unusually *predictable* is more likely machine-
written than one that keeps surprising it. For every long-enough paragraph we
run the reference LM once and measure three things:

  * mean_nll   — average negative log-likelihood per token (perplexity, log
                 scale). Lower = more predictable = more AI-like.
  * top1_frac  — share of tokens that were exactly the LM's #1 guess
                 (the GLTR idea). Higher = more AI-like.
  * sent_std   — spread of per-sentence mean_nll ("burstiness"). Human writing
                 mixes easy and surprising sentences; LLM output is flatter.
                 Lower = more AI-like.

A logistic model over the three gives a per-paragraph probability; the report
carries per-paragraph scores (so the UI can point at *which* paragraphs), a
word-weighted overall score, and plain-language reasons derived from the same
numbers.

The reference LM is the Qwen model llm_metadata already loads lazily for the
local rewrite / metadata paths, so this adds no second model to the GPU. When
that model isn't available (CPU-only host, failed load) the result is
`{"available": False, ...}` and the check carries on without it — this module
must never fail or slow a plagiarism check past its own bounded work.

Honesty notes (also surfaced to the user in `disclaimer`)
---------------------------------------------------------
Detectors of this family are probabilistic: heavily edited AI text, and very
formulaic human text (boilerplate, definitions, tables of contents), can fall
on the wrong side. The weights below were fit on a small English sample (see
`CALIBRATION` for exactly what), so other languages are reported with
`confidence: "low"`.
"""

from __future__ import annotations

import logging
import math
import re
import unicodedata

logger = logging.getLogger(__name__)

METHOD = "lm_predictability_v1"

MIN_WORDS_PER_SEGMENT = 40
MIN_TOTAL_WORDS = 120  # below this the overall number is too noisy to trust
MAX_SEGMENT_TOKENS = 384
# Bounds the LM work per check (~a few seconds on a GPU). Longer documents are
# sampled evenly across their length rather than truncated to the first pages.
MAX_SEGMENTS = 60

LEVEL_POSSIBLE = 30.0
LEVEL_LIKELY = 60.0
SEGMENT_FLAG_THRESHOLD = 0.60

# Logistic weights over (mean_nll, top1_frac, sent_std), fit with sklearn
# LogisticRegression(C=0.3, class_weight="balanced") on the sample described in
# CALIBRATION, so a probability of 0.5 means "as likely AI as human" whatever
# the mix of the training set.
WEIGHTS = {"bias": 2.215, "mean_nll": -1.917, "top1_frac": 7.395, "sent_std": -2.370}

# What those weights were fit on — kept in code so nobody mistakes them for a
# validated production classifier. 48 English paragraphs of 60-170 words:
#   human (32): pre-2020 arXiv ML papers, PDF text (so hyphenation/ligature
#               artefacts included, as in real uploads);
#   AI    (16): chat-assistant style essay / related-work paragraphs (half
#               technical, half general) written by a Claude model.
# Reference LM: Qwen/Qwen2.5-1.5B-Instruct, 4-bit.
# Leave-one-out on that sample: AUC 0.994; at a 0.6 cut-off 1/32 human
# paragraphs flagged and 15/16 AI paragraphs caught. Feature means:
#   human mean_nll 2.89, top1_frac 0.43, sent_std 0.77
#   AI    mean_nll 1.75, top1_frac 0.57, sent_std 0.52
# Not covered: Vietnamese/other languages, heavily edited AI text, non-technical
# human writing (likely more predictable than arXiv prose => more false
# positives), other LLMs' styles. Treat the number as a triage signal.
CALIBRATION = {
    "reference_lm": "Qwen/Qwen2.5-1.5B-Instruct",
    "n_human": 32,
    "n_ai": 16,
    "language": "en",
    "loo_auc": 0.994,
    "neutral_sent_std": 0.677,
    "human_mean_nll": 2.89,
    "ai_mean_nll": 1.75,
}

DISCLAIMER = (
    "This is a statistical estimate, not proof. Edited AI text and very formulaic "
    "human writing can be misjudged, so use it as a prompt to review the flagged "
    "paragraphs, not as a verdict."
)

_VIETNAMESE_LETTERS = set(
    "ăâđêôơư"
    "àáảãạằắẳẵặầấẩẫậ"
    "èéẻẽẹềếểễệ"
    "ìíỉĩị"
    "òóỏõọồốổỗộờớởỡợ"
    "ùúủũụừứửữựỳýỷỹỵ"
)

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?…])\s+")
# PDF text often carries line-break hyphenation ("detec- tion"): it is a
# property of the extraction, not the author, and it would inflate perplexity
# and make human text look more human than it is.
_HYPHEN_BREAK = re.compile(r"(\w)-\s+(?=[a-zà-ỹ])")


class DetectorUnavailable(RuntimeError):
    """The reference LM could not be used on this host."""


# ---------------------------------------------------------------------------
# Pure helpers (no model needed) — unit tested without a GPU.
# ---------------------------------------------------------------------------

def normalize_text(text: str) -> str:
    # NFKC folds PDF ligatures ("ﬁ" -> "fi") that would otherwise read as rare tokens.
    text = _HYPHEN_BREAK.sub(r"\1", unicodedata.normalize("NFKC", text or ""))
    return re.sub(r"\s+", " ", text).strip()


def count_words(text: str) -> int:
    return len(text.split())


def guess_language(text: str) -> str:
    letters = [c for c in text.lower() if c.isalpha()]
    if not letters:
        return "unknown"
    vi = sum(1 for c in letters if c in _VIETNAMESE_LETTERS)
    if vi / len(letters) >= 0.03:
        return "vi"
    ascii_share = sum(1 for c in letters if c < "\u0080") / len(letters)
    return "en" if ascii_share > 0.97 else "other"


def _sigmoid(z: float) -> float:
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    e = math.exp(z)
    return e / (1.0 + e)


def score_from_features(features: dict, weights: dict | None = None) -> float:
    """Per-segment AI probability in [0, 1] from the three LM features."""
    w = weights or WEIGHTS
    z = (
        w["bias"]
        + w["mean_nll"] * features["mean_nll"]
        + w["top1_frac"] * features["top1_frac"]
        + w["sent_std"] * features["sent_std"]
    )
    return _sigmoid(z)


def level_for(score: float) -> str:
    if score >= LEVEL_LIKELY:
        return "likely"
    if score >= LEVEL_POSSIBLE:
        return "possible"
    return "low"


def select_segments(document: dict | None, input_text: str) -> list[dict]:
    """
    Paragraph-sized units to analyse, each `{start, end, block_id, text, words}`
    with offsets into `input_text` (the same coordinates the report's matches
    use, so the UI can highlight them). Headings, tables, images and short
    fragments are skipped: they say nothing about authorship.
    """
    segments: list[dict] = []
    blocks = (document or {}).get("blocks") or []

    if blocks:
        for block in blocks:
            if block.get("type") not in ("paragraph", "list_item"):
                continue
            start, end = block.get("start"), block.get("end")
            if start is None or end is None or end <= start:
                continue
            text = normalize_text(input_text[start:end])
            words = count_words(text)
            if words >= MIN_WORDS_PER_SEGMENT:
                segments.append(
                    {"start": start, "end": end, "block_id": block.get("block_id"), "text": text, "words": words}
                )
    else:
        # Pasted text with no structure: split on blank lines.
        cursor = 0
        for part in re.split(r"\n\s*\n", input_text or ""):
            start = (input_text or "").find(part, cursor)
            if start < 0:
                continue
            end = start + len(part)
            cursor = end
            text = normalize_text(part)
            words = count_words(text)
            if words >= MIN_WORDS_PER_SEGMENT:
                segments.append({"start": start, "end": end, "block_id": None, "text": text, "words": words})

    if len(segments) > MAX_SEGMENTS:
        step = len(segments) / MAX_SEGMENTS
        segments = [segments[int(i * step)] for i in range(MAX_SEGMENTS)]
    return segments


def build_reasons(avg: dict, overall: float, share: float, language: str) -> list[str]:
    """Plain-language reasons taken from the same numbers the score used."""
    reasons: list[str] = []
    typical_human = math.exp(CALIBRATION["human_mean_nll"])
    if avg["mean_nll"] <= 2.4:
        reasons.append(
            "The wording is very predictable to a language model "
            f"(perplexity ≈ {math.exp(avg['mean_nll']):.0f}, versus ≈ {typical_human:.0f} for typical human "
            "academic writing); machine-written text tends to pick the most expected word."
        )
    elif avg["mean_nll"] >= 3.2:
        reasons.append(
            "The wording is fairly unpredictable "
            f"(perplexity ≈ {math.exp(avg['mean_nll']):.0f}), which is typical of human writing."
        )
    if avg["top1_frac"] >= 0.5:
        reasons.append(
            f"{avg['top1_frac'] * 100:.0f}% of the words were the language model's single top guess, "
            "which is higher than usual for human writing."
        )
    if avg["sent_std"] <= 0.6:
        reasons.append(
            "Sentence-to-sentence variation is low: the text keeps the same even rhythm throughout, "
            "while human writing usually mixes easy and surprising sentences."
        )
    if share > 0:
        reasons.append(
            f"About {share:.0f}% of the analysed text sits in paragraphs that individually look machine-written."
        )
    if not reasons:
        reasons.append("No strong sign of machine-written text was found in the analysed paragraphs.")
    if language != "en":
        reasons.append(
            "This detector was calibrated on English; results for other languages are less reliable, "
            "so a text is never labelled 'likely' AI-written on this evidence alone."
        )
    return reasons


def _excerpt(text: str, limit: int = 160) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def summarize(segment_results: list[dict], *, language: str, model_name: str) -> dict:
    """Combine per-segment results into the report's `ai_detection` block."""
    total_words = sum(s["words"] for s in segment_results)
    if not segment_results or total_words == 0:
        return {
            "available": True,
            "method": METHOD,
            "model": model_name,
            "overall_score": 0,
            "level": "low",
            "confidence": "low",
            "language": language,
            "analyzed_words": 0,
            "ai_share": 0,
            "segments": [],
            "reasons": ["Not enough running text to analyse (paragraphs under 40 words are skipped)."],
            "disclaimer": DISCLAIMER,
        }

    overall = sum(s["probability"] * s["words"] for s in segment_results) / total_words * 100
    flagged_words = sum(s["words"] for s in segment_results if s["probability"] >= SEGMENT_FLAG_THRESHOLD)
    share = flagged_words / total_words * 100

    avg = {
        key: sum(s["features"][key] * s["words"] for s in segment_results) / total_words
        for key in ("mean_nll", "top1_frac", "sent_std")
    }

    confidence = "normal" if language == "en" and total_words >= MIN_TOTAL_WORDS else "low"
    level = level_for(overall)
    if confidence == "low" and level == "likely":
        # The weights were fit on English and a short/non-English text can't be
        # validated, so never tell someone their work is "likely" machine-written
        # on evidence this weak — cap at "possible" (the reasons say why).
        level = "possible"

    return {
        "available": True,
        "method": METHOD,
        "model": model_name,
        "overall_score": round(overall, 1),
        "level": level,
        "confidence": confidence,
        "language": language,
        "analyzed_words": total_words,
        "ai_share": round(share, 1),
        "segments": [
            {
                "start": s["start"],
                "end": s["end"],
                "block_id": s["block_id"],
                "words": s["words"],
                "score": round(s["probability"] * 100, 1),
                # First words of the paragraph so the UI can say *which* one it is
                # even when it only has the persisted report, not the full text.
                "excerpt": _excerpt(s.get("text", "")),
            }
            for s in segment_results
        ],
        "reasons": build_reasons(avg, overall, share, language),
        "disclaimer": DISCLAIMER,
    }


# ---------------------------------------------------------------------------
# Model-backed part
# ---------------------------------------------------------------------------

def _lm_handles():
    import llm_metadata

    llm_metadata._ensure_local_model_loaded()
    tokenizer, model = llm_metadata._tokenizer, llm_metadata._model
    if tokenizer is None or model is None:
        raise DetectorUnavailable("Local language model failed to load.")
    return tokenizer, model


def segment_features(text: str) -> dict | None:
    """
    LM features for one paragraph, or None if it is too short after
    tokenisation. Raises DetectorUnavailable if the LM can't be used.
    """
    try:
        import torch

        tokenizer, model = _lm_handles()
        enc = tokenizer(
            text,
            return_tensors="pt",
            truncation=True,
            max_length=MAX_SEGMENT_TOKENS,
            return_offsets_mapping=True,
        )
        offsets = enc.pop("offset_mapping")[0].tolist()
        ids = enc["input_ids"][0]
        if ids.shape[0] < 16:
            return None

        start_id = tokenizer.convert_tokens_to_ids("<|endoftext|>")
        if start_id is None or start_id < 0:
            start_id = tokenizer.eos_token_id
        input_ids = torch.cat([torch.tensor([start_id]), ids]).unsqueeze(0).to(model.device)

        with torch.no_grad():
            logits = model(input_ids=input_ids).logits[0, :-1].float()
        target = ids.to(logits.device)
        log_probs = torch.log_softmax(logits, dim=-1)
        nll = (-log_probs[torch.arange(target.shape[0]), target]).cpu().tolist()
        top1 = (logits.argmax(dim=-1) == target).float().cpu().tolist()
    except DetectorUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001 — any torch/CUDA/tokenizer failure => feature unavailable
        raise DetectorUnavailable(str(exc)) from exc

    # Per-sentence mean NLL -> burstiness.
    boundaries = []
    cursor = 0
    for sentence in _SENTENCE_SPLIT.split(text):
        boundaries.append((cursor, cursor + len(sentence)))
        cursor += len(sentence) + 1
    per_sentence: list[list[float]] = [[] for _ in boundaries]
    for (tok_start, _), value in zip(offsets, nll):
        for i, (b_start, b_end) in enumerate(boundaries):
            if b_start <= tok_start < b_end + 1:
                per_sentence[i].append(value)
                break
    means = [sum(v) / len(v) for v in per_sentence if len(v) >= 5]
    if len(means) >= 3:
        mu = sum(means) / len(means)
        sent_std = math.sqrt(sum((m - mu) ** 2 for m in means) / len(means))
    else:
        sent_std = None

    return {
        "mean_nll": sum(nll) / len(nll),
        "top1_frac": sum(top1) / len(top1),
        "sent_std": sent_std,
        "tokens": len(nll),
    }


def detect_ai_content(document: dict | None, input_text: str, *, extractor=segment_features) -> dict:
    """
    Build the report's `ai_detection` block. `extractor` is injectable so tests
    (and calibration) can run without a GPU. Never raises: an unusable LM
    yields `{"available": False, "reason": ...}`.
    """
    try:
        segments = select_segments(document, input_text)
        language = guess_language(normalize_text(input_text)[:6000])
        results: list[dict] = []

        for seg in segments:
            feats = extractor(seg["text"])
            if feats is None:
                continue
            if feats.get("sent_std") is None:
                # Too few sentences to measure burstiness: use the neutral
                # calibration value so it neither helps nor hurts the score.
                feats = {**feats, "sent_std": CALIBRATION.get("neutral_sent_std", 0.8)}
            results.append({**seg, "features": feats, "probability": score_from_features(feats)})

        model_name = _model_name()
        return summarize(results, language=language, model_name=model_name)
    except DetectorUnavailable as exc:
        logger.warning("AI-content detection unavailable: %s", exc)
        return {"available": False, "method": METHOD, "reason": str(exc)}
    except Exception as exc:  # noqa: BLE001
        logger.exception("AI-content detection failed")
        return {"available": False, "method": METHOD, "reason": f"unexpected error: {exc}"}


def _model_name() -> str:
    try:
        from config import LLM_MODEL_NAME

        return LLM_MODEL_NAME
    except Exception:  # noqa: BLE001
        return "unknown"
