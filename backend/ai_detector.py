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
import os
import re
import threading
import unicodedata

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Detection mode — change this number (or set the AI_DETECTION_MODE env var):
#
#   1 = lm_predictability_v1 (the original single-model detector) + an honest
#       "inconclusive" result: when the text is not English or too short for
#       the calibration to apply, the report says "not enough evidence to
#       judge" instead of showing a reassuring low percentage.
#   2 = Binoculars (Hans et al., 2024): two models from the same family
#       (observer = base, performer = instruct) and the ratio of the text's
#       perplexity to their cross-perplexity. More robust than perplexity
#       alone, but loads a second model and its threshold is NOT yet
#       calibrated for the Qwen pair — see BINOCULARS_THRESHOLD below.
#   3 = English: a fine-tuned AI-text classifier
#       (wasitaigeneratedcom/ai-text-detector-small, DeBERTa-v3-large, 4
#       classes human / ai / ai_edited / humanized). Other languages fall
#       back to mode 1 — there is no trained Vietnamese detector yet
#       (Fsoft-AIC/videberta-xsmall is a plain Vietnamese language model, not
#       a detector: it would first have to be fine-tuned on labelled
#       human/AI Vietnamese text).
#       Vietnamese: VietBinoculars (github.com/trieuntu/VietAIDetector) —
#       Binoculars with the vinai/PhoGPT-4B + PhoGPT-4B-Chat pair, int8
#       (~7.3 GB VRAM; int4 was tested and breaks the score). The language is
#       picked automatically from the text; if the PhoGPT pair can't run,
#       Vietnamese also falls back to mode 1.
# ---------------------------------------------------------------------------
AI_DETECTION_MODE = int(os.getenv("AI_DETECTION_MODE", "3"))

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
                # The three measurements behind the score, so the UI can
                # explain *this* paragraph in the reader's language.
                "features": {
                    key: round(float(s["features"][key]), 3)
                    for key in ("mean_nll", "top1_frac", "sent_std")
                    if key in (s.get("features") or {})
                },
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
    if AI_DETECTION_MODE == 2 and extractor is segment_features:
        return detect_ai_content_binoculars(document, input_text)

    if AI_DETECTION_MODE == 3 and extractor is segment_features:
        if guess_language(normalize_text(input_text)[:6000]) == "en":
            return detect_ai_content_classifier(document, input_text)
        if guess_language(normalize_text(input_text)[:6000]) == "vi":
            viet = detect_ai_content_viet(document, input_text)
            if viet.get("available"):
                return mark_inconclusive(viet)
            # PhoGPT pair unusable on this host (no GPU, load failure): use mode 1.
        # Not English: the classifier wasn't trained on it — use mode 1.

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
        summary = summarize(results, language=language, model_name=model_name)
        if AI_DETECTION_MODE in (1, 3):
            summary = mark_inconclusive(summary)
        return summary
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


# ---------------------------------------------------------------------------
# Mode 1: inconclusive instead of a reassuring number
# ---------------------------------------------------------------------------

INCONCLUSIVE_REASON = (
    "Not enough evidence to judge: the detector was calibrated on English academic writing, "
    "and this text is not English or is too short, so no percentage is shown."
)


def mark_inconclusive(summary: dict) -> dict:
    """
    Mode 1. A low-confidence result (non-English or too short — see
    summarize()) gets `inconclusive: True`, so the UI shows "not enough
    evidence to judge" instead of a percentage. A low number on text the
    detector was never calibrated for reads as "human-written" when it only
    means "unknown". The score stays in the data for debugging.
    """
    if not summary.get("available") or summary.get("confidence") != "low":
        return summary
    return {
        **summary,
        "inconclusive": True,
        "reasons": [INCONCLUSIVE_REASON] + list(summary.get("reasons") or []),
    }


# ---------------------------------------------------------------------------
# Mode 2: Binoculars (two-model cross-perplexity)
# ---------------------------------------------------------------------------
#
# Hans et al., "Spotting LLMs With Binoculars: Zero-Shot Detection of
# Machine-Generated Text" (ICML 2024). For a text s, with an observer model
# M1 and a performer model M2 that share a tokenizer:
#
#     B(s) = log PPL_M2(s) / X-PPL_{M1,M2}(s)
#
#   log PPL  = mean over tokens of the performer's cross-entropy on s;
#   X-PPL    = mean over tokens of the cross-entropy between the observer's
#              next-token distribution and the performer's.
#
# Dividing by X-PPL normalizes away "how surprising is this topic/prompt at
# all", which is what lets perplexity-only detectors be fooled by unusual
# subject matter or style. Lower B => more machine-like.

METHOD_BINOCULARS = "binoculars_v1"

BINOCULARS_OBSERVER_MODEL = os.getenv("BINOCULARS_OBSERVER_MODEL", "Qwen/Qwen2.5-1.5B")

# The paper's Falcon-7B pair uses ~0.90 as its decision threshold. The Qwen
# 1.5B pair here has NOT been calibrated: measure B on known human and AI
# paragraphs and set this to the cut-off between them before trusting it.
BINOCULARS_THRESHOLD = float(os.getenv("BINOCULARS_THRESHOLD", "0.90"))
# Width of the soft step that turns B into a probability: B one SCALE below
# the threshold => ~73% AI, two below => ~88%.
BINOCULARS_SCALE = float(os.getenv("BINOCULARS_SCALE", "0.05"))

BINOCULARS_METHOD_NOTE = (
    "Method: Binoculars (two-model cross-perplexity). Its threshold has not yet been "
    "calibrated for this model pair, so treat the number as a hint."
)

_observer_model = None


def binoculars_probability(score: float, threshold: float | None = None, scale: float | None = None) -> float:
    """AI probability in [0, 1] from a Binoculars score (lower score => higher probability)."""
    threshold = BINOCULARS_THRESHOLD if threshold is None else threshold
    scale = BINOCULARS_SCALE if scale is None else scale
    return _sigmoid((threshold - score) / scale)


def _observer_handles():
    """Performer = the instruct model llm_metadata already loads; observer = its base model."""
    global _observer_model
    tokenizer, performer = _lm_handles()

    if _observer_model is None:
        try:
            import torch
            from transformers import AutoModelForCausalLM, BitsAndBytesConfig

            logger.info("Loading Binoculars observer model %s...", BINOCULARS_OBSERVER_MODEL)
            bnb_config = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_compute_dtype=torch.float16,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_use_double_quant=True,
            )
            model = AutoModelForCausalLM.from_pretrained(
                BINOCULARS_OBSERVER_MODEL,
                quantization_config=bnb_config,
                device_map="auto",
                trust_remote_code=True,
                low_cpu_mem_usage=True,
            )
            model.eval()
            _observer_model = model
        except Exception as exc:  # noqa: BLE001
            raise DetectorUnavailable(f"Binoculars observer model failed to load: {exc}") from exc

    return tokenizer, _observer_model, performer


def binoculars_features(text: str) -> dict | None:
    """
    Binoculars score for one paragraph, or None if it is too short after
    tokenisation. Raises DetectorUnavailable if either model can't be used.
    """
    try:
        import torch

        tokenizer, observer, performer = _observer_handles()
        enc = tokenizer(text, return_tensors="pt", truncation=True, max_length=MAX_SEGMENT_TOKENS)
        ids = enc["input_ids"][0]
        if ids.shape[0] < 16:
            return None

        start_id = tokenizer.convert_tokens_to_ids("<|endoftext|>")
        if start_id is None or start_id < 0:
            start_id = tokenizer.eos_token_id
        input_ids = torch.cat([torch.tensor([start_id]), ids]).unsqueeze(0)

        with torch.no_grad():
            observer_logits = observer(input_ids=input_ids.to(observer.device)).logits[0, :-1].float()
            performer_logits = performer(input_ids=input_ids.to(performer.device)).logits[0, :-1].float()

        performer_logits = performer_logits.to(observer_logits.device)
        vocab = min(observer_logits.shape[-1], performer_logits.shape[-1])
        observer_logits = observer_logits[:, :vocab]
        performer_logits = performer_logits[:, :vocab]
        target = ids.to(observer_logits.device)

        performer_log_probs = torch.log_softmax(performer_logits, dim=-1)
        log_ppl = float((-performer_log_probs[torch.arange(target.shape[0]), target]).mean())
        observer_probs = torch.softmax(observer_logits, dim=-1)
        x_ppl = float((-(observer_probs * performer_log_probs).sum(dim=-1)).mean())
    except DetectorUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001 — any torch/CUDA/tokenizer failure => feature unavailable
        raise DetectorUnavailable(str(exc)) from exc

    if x_ppl <= 0:
        return None

    return {
        "binoculars": log_ppl / x_ppl,
        "log_ppl": log_ppl,
        "x_ppl": x_ppl,
        "tokens": int(ids.shape[0]),
    }


def build_binoculars_reasons(avg_score: float, share: float, language: str, threshold: float | None = None) -> list[str]:
    threshold = BINOCULARS_THRESHOLD if threshold is None else threshold
    reasons: list[str] = []
    if avg_score < threshold:
        reasons.append(
            f"Binoculars score ≈ {avg_score:.2f}, below the {threshold:.2f} threshold: relative to how "
            "surprising the topic is, the wording is as predictable as a language model's own output."
        )
    else:
        reasons.append(
            f"Binoculars score ≈ {avg_score:.2f}, above the {threshold:.2f} threshold, which is typical of human writing."
        )
    if share > 0:
        reasons.append(
            f"About {share:.0f}% of the analysed text sits in paragraphs that individually look machine-written."
        )
    if language != "en":
        reasons.append(
            "This detector was calibrated on English; results for other languages are less reliable, "
            "so a text is never labelled 'likely' AI-written on this evidence alone."
        )
    reasons.append(BINOCULARS_METHOD_NOTE)
    return reasons


def summarize_binoculars(segment_results: list[dict], *, language: str, model_name: str) -> dict:
    """Same `ai_detection` shape as summarize(), so the UI needs no second code path."""
    total_words = sum(s["words"] for s in segment_results)
    if not segment_results or total_words == 0:
        return {
            "available": True,
            "method": METHOD_BINOCULARS,
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
    avg_score = sum(s["features"]["binoculars"] * s["words"] for s in segment_results) / total_words

    confidence = "normal" if language == "en" and total_words >= MIN_TOTAL_WORDS else "low"
    level = level_for(overall)
    if confidence == "low" and level == "likely":
        level = "possible"

    return {
        "available": True,
        "method": METHOD_BINOCULARS,
        "model": model_name,
        "overall_score": round(overall, 1),
        "level": level,
        "confidence": confidence,
        "language": language,
        "analyzed_words": total_words,
        "ai_share": round(share, 1),
        "binoculars_threshold": BINOCULARS_THRESHOLD,
        "segments": [
            {
                "start": s["start"],
                "end": s["end"],
                "block_id": s["block_id"],
                "words": s["words"],
                "score": round(s["probability"] * 100, 1),
                "excerpt": _excerpt(s.get("text", "")),
                "features": {
                    key: round(float(s["features"][key]), 3)
                    for key in ("binoculars", "log_ppl", "x_ppl")
                    if key in (s.get("features") or {})
                },
            }
            for s in segment_results
        ],
        "reasons": build_binoculars_reasons(avg_score, share, language),
        "disclaimer": DISCLAIMER,
    }


def detect_ai_content_binoculars(document: dict | None, input_text: str, *, extractor=binoculars_features) -> dict:
    """Mode 2 counterpart of detect_ai_content(). Never raises."""
    try:
        segments = select_segments(document, input_text)
        language = guess_language(normalize_text(input_text)[:6000])
        results: list[dict] = []

        for seg in segments:
            feats = extractor(seg["text"])
            if feats is None:
                continue
            results.append({**seg, "features": feats, "probability": binoculars_probability(feats["binoculars"])})

        model_name = f"{BINOCULARS_OBSERVER_MODEL} + {_model_name()}"
        return summarize_binoculars(results, language=language, model_name=model_name)
    except DetectorUnavailable as exc:
        logger.warning("AI-content detection (Binoculars) unavailable: %s", exc)
        return {"available": False, "method": METHOD_BINOCULARS, "reason": str(exc)}
    except Exception as exc:  # noqa: BLE001
        logger.exception("AI-content detection (Binoculars) failed")
        return {"available": False, "method": METHOD_BINOCULARS, "reason": f"unexpected error: {exc}"}


# ---------------------------------------------------------------------------
# Mode 3: fine-tuned English AI-text classifier
# ---------------------------------------------------------------------------
#
# wasitaigeneratedcom/ai-text-detector-small (Apache-2.0): DeBERTa-v3-large,
# mean-pooled, a linear head over 4 classes. Its model card defines
# ai_score = 1 - P(human) and recommends flagging at ai_score >= 0.976
# (0.5% false-positive rate on their benchmark). English only; inputs
# longer than 768 tokens are truncated per paragraph.

METHOD_CLASSIFIER = "ai_text_classifier_v1"

AI_TEXT_DETECTOR_MODEL = os.getenv("AI_TEXT_DETECTOR_MODEL", "wasitaigeneratedcom/ai-text-detector-small")
CLASSIFIER_LABELS = ("human", "ai", "ai_edited", "humanized")
CLASSIFIER_MAX_TOKENS = 768
CLASSIFIER_THRESHOLD = float(os.getenv("AI_TEXT_DETECTOR_THRESHOLD", "0.976"))

CLASSIFIER_METHOD_NOTE = (
    "Method: a fine-tuned AI-text classifier (DeBERTa-v3), trained on English only."
)

_classifier = None  # (tokenizer, model)


def classifier_probability(ai_score: float, threshold: float | None = None) -> float:
    """
    Map the model's ai_score onto this module's probability scale so its
    recommended cut-off lands exactly on SEGMENT_FLAG_THRESHOLD: piecewise
    linear and monotonic, 0 -> 0, threshold -> 0.6, 1 -> 1. Without this a
    human paragraph at ai_score 0.9 (well below the card's 0.976) would be
    flagged as machine-written.
    """
    threshold = CLASSIFIER_THRESHOLD if threshold is None else threshold
    ai_score = min(1.0, max(0.0, ai_score))
    if ai_score <= threshold:
        return SEGMENT_FLAG_THRESHOLD * ai_score / threshold
    return SEGMENT_FLAG_THRESHOLD + (1 - SEGMENT_FLAG_THRESHOLD) * (ai_score - threshold) / (1 - threshold)


def _classifier_handles():
    global _classifier
    if _classifier is not None:
        return _classifier

    try:
        import torch
        import torch.nn as nn
        from transformers import AutoConfig, AutoModel, AutoTokenizer, PreTrainedModel

        # Model class as published on the model card (mean pooling + linear head).
        class AIDetectionModel(PreTrainedModel):
            config_class = AutoConfig
            _tied_weights_keys = []

            @property
            def all_tied_weights_keys(self):
                return {}

            def __init__(self, config):
                super().__init__(config)
                self.model = AutoModel.from_config(config)
                n = getattr(config, "detector_num_labels", 1)
                self.classifier = nn.Linear(config.hidden_size, n)

            def forward(self, input_ids, attention_mask=None, **kwargs):
                out = self.model(input_ids, attention_mask=attention_mask)
                h = out[0]
                mask = attention_mask.unsqueeze(-1).float()
                pooled = (h * mask).sum(1) / mask.sum(1)
                return self.classifier(pooled)

        logger.info("Loading AI-text classifier %s...", AI_TEXT_DETECTOR_MODEL)
        tokenizer = AutoTokenizer.from_pretrained(AI_TEXT_DETECTOR_MODEL)
        model = AIDetectionModel.from_pretrained(AI_TEXT_DETECTOR_MODEL).eval()
        if torch.cuda.is_available():
            model = model.to("cuda")
        _classifier = (tokenizer, model)
    except Exception as exc:  # noqa: BLE001
        raise DetectorUnavailable(f"AI-text classifier failed to load: {exc}") from exc

    return _classifier


def classifier_features(text: str) -> dict | None:
    """Class probabilities for one paragraph. Raises DetectorUnavailable if the model can't be used."""
    try:
        import torch

        tokenizer, model = _classifier_handles()
        enc = tokenizer(text, truncation=True, max_length=CLASSIFIER_MAX_TOKENS, return_tensors="pt")
        if enc["input_ids"].shape[1] < 16:
            return None
        device = next(model.parameters()).device
        enc = {k: v.to(device) for k, v in enc.items()}
        with torch.inference_mode():
            probs = torch.softmax(model(**enc).float(), dim=-1)[0].cpu().tolist()
    except DetectorUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001
        raise DetectorUnavailable(str(exc)) from exc

    if len(probs) != len(CLASSIFIER_LABELS):
        raise DetectorUnavailable(f"AI-text classifier returned {len(probs)} classes, expected {len(CLASSIFIER_LABELS)}.")

    features = {f"p_{label}": p for label, p in zip(CLASSIFIER_LABELS, probs)}
    features["ai_score"] = 1.0 - features["p_human"]
    return features


def build_classifier_reasons(avg: dict, share: float) -> list[str]:
    """`avg` holds word-weighted class probabilities (p_human, p_ai, p_ai_edited, p_humanized)."""
    reasons = [
        f"Classifier estimate: {avg['p_human'] * 100:.0f}% human, {avg['p_ai'] * 100:.0f}% raw AI, "
        f"{avg['p_ai_edited'] * 100:.0f}% AI-edited, {avg['p_humanized'] * 100:.0f}% humanized AI text."
    ]
    if share > 0:
        reasons.append(
            f"About {share:.0f}% of the analysed text sits in paragraphs that individually look machine-written."
        )
    else:
        reasons.append("No strong sign of machine-written text was found in the analysed paragraphs.")
    reasons.append(CLASSIFIER_METHOD_NOTE)
    return reasons


def summarize_classifier(segment_results: list[dict], *, language: str, model_name: str) -> dict:
    """Same `ai_detection` shape as summarize()."""
    total_words = sum(s["words"] for s in segment_results)
    if not segment_results or total_words == 0:
        return {
            "available": True,
            "method": METHOD_CLASSIFIER,
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
        for key in ("p_human", "p_ai", "p_ai_edited", "p_humanized")
    }

    confidence = "normal" if language == "en" and total_words >= MIN_TOTAL_WORDS else "low"
    level = level_for(overall)
    if confidence == "low" and level == "likely":
        level = "possible"

    return {
        "available": True,
        "method": METHOD_CLASSIFIER,
        "model": model_name,
        "overall_score": round(overall, 1),
        "level": level,
        "confidence": confidence,
        "language": language,
        "analyzed_words": total_words,
        "ai_share": round(share, 1),
        "classifier_threshold": CLASSIFIER_THRESHOLD,
        "segments": [
            {
                "start": s["start"],
                "end": s["end"],
                "block_id": s["block_id"],
                "words": s["words"],
                "score": round(s["probability"] * 100, 1),
                "excerpt": _excerpt(s.get("text", "")),
                "features": {
                    key: round(float(s["features"][key]), 3)
                    for key in ("ai_score", "p_human", "p_ai", "p_ai_edited", "p_humanized")
                    if key in (s.get("features") or {})
                },
            }
            for s in segment_results
        ],
        "reasons": build_classifier_reasons(avg, share),
        "disclaimer": DISCLAIMER,
    }


def detect_ai_content_classifier(document: dict | None, input_text: str, *, extractor=classifier_features) -> dict:
    """Mode 3 (English text) counterpart of detect_ai_content(). Never raises."""
    try:
        segments = select_segments(document, input_text)
        language = guess_language(normalize_text(input_text)[:6000])
        results: list[dict] = []

        for seg in segments:
            feats = extractor(seg["text"])
            if feats is None:
                continue
            results.append({**seg, "features": feats, "probability": classifier_probability(feats["ai_score"])})

        return summarize_classifier(results, language=language, model_name=AI_TEXT_DETECTOR_MODEL)
    except DetectorUnavailable as exc:
        logger.warning("AI-content detection (classifier) unavailable: %s", exc)
        return {"available": False, "method": METHOD_CLASSIFIER, "reason": str(exc)}
    except Exception as exc:  # noqa: BLE001
        logger.exception("AI-content detection (classifier) failed")
        return {"available": False, "method": METHOD_CLASSIFIER, "reason": f"unexpected error: {exc}"}


# ---------------------------------------------------------------------------
# Mode 3, Vietnamese: VietBinoculars (PhoGPT-4B pair, int8)
# ---------------------------------------------------------------------------
#
# Same Binoculars score as mode 2 (see above), computed exactly as
# VietAIDetector's core/scorer.py + core/metrics.py: PPL from the shifted
# performer logits, X-PPL over every position. Thresholds are the
# VietBinoculars paper's; we use its "Low FPR" one (0.899).
#
# Measured on an RTX 4070 SUPER (12 GB), 450-token inputs:
#   int8: 7.06 GB weights, 7.30 GB peak, ~0.16 s per paragraph. AUC 0.954
#         against 53 VnExpress articles from Oct 2026 (author's bf16 run:
#         0.96). At 0.899: 88% of AI text caught, 13% of that news flagged.
#   int4: 3.7 GB but AUC ~0.5 — the quantisation noise swamps the score.
# Known weakness: text PhoGPT memorised in training (Wikipedia, famous
# literature, textbook definitions) is very predictable to it and scores
# like AI — ~75% of such paragraphs were flagged in the same test.

METHOD_VIET_BINOCULARS = "viet_binoculars_v1"

VIET_OBSERVER_MODEL = os.getenv("VIET_OBSERVER_MODEL", "vinai/PhoGPT-4B")
VIET_PERFORMER_MODEL = os.getenv("VIET_PERFORMER_MODEL", "vinai/PhoGPT-4B-Chat")
VIET_BINOCULARS_THRESHOLD = float(os.getenv("VIET_BINOCULARS_THRESHOLD", "0.8992537260055542"))
# AI text scored ~0.80 and fresh human news ~0.98 in the test above, so a
# 0.03 step puts both ends near 5% / 95%.
VIET_BINOCULARS_SCALE = float(os.getenv("VIET_BINOCULARS_SCALE", "0.03"))
VIET_MAX_TOKENS = 450

VIET_METHOD_NOTE = (
    "Method: VietBinoculars (PhoGPT-4B model pair). Well-known text the model has memorised, "
    "such as Wikipedia passages, famous literature or textbook definitions, can be wrongly flagged as AI."
)

_viet_models = None  # (tokenizer, observer, performer)
# Concurrent first Vietnamese checks would otherwise each load the ~7.3 GB pair.
_viet_models_lock = threading.Lock()


def _viet_handles():
    global _viet_models
    if _viet_models is not None:
        return _viet_models

    with _viet_models_lock:
        if _viet_models is not None:
            return _viet_models

        try:
            import torch
            from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

            if not torch.cuda.is_available():
                raise DetectorUnavailable("VietBinoculars needs a CUDA GPU (~7.3 GB VRAM).")

            logger.info("Loading VietBinoculars pair %s + %s (int8)...", VIET_OBSERVER_MODEL, VIET_PERFORMER_MODEL)
            kwargs = dict(
                trust_remote_code=True,
                quantization_config=BitsAndBytesConfig(load_in_8bit=True),
                device_map={"": 0},
                torch_dtype=torch.bfloat16,
            )
            tokenizer = AutoTokenizer.from_pretrained(VIET_OBSERVER_MODEL, trust_remote_code=True)
            if not tokenizer.pad_token:
                tokenizer.pad_token = tokenizer.eos_token
            observer = AutoModelForCausalLM.from_pretrained(VIET_OBSERVER_MODEL, **kwargs).eval()
            performer = AutoModelForCausalLM.from_pretrained(VIET_PERFORMER_MODEL, **kwargs).eval()
            _viet_models = (tokenizer, observer, performer)
        except DetectorUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001
            raise DetectorUnavailable(f"VietBinoculars models failed to load: {exc}") from exc

    return _viet_models


def viet_binoculars_features(text: str) -> dict | None:
    """VietBinoculars score for one paragraph. Raises DetectorUnavailable if the pair can't be used."""
    try:
        import torch

        tokenizer, observer, performer = _viet_handles()
        enc = tokenizer(
            text, return_tensors="pt", truncation=True, max_length=VIET_MAX_TOKENS, return_token_type_ids=False
        ).to(0)
        if enc.input_ids.shape[1] < 16:
            return None
        with torch.inference_mode():
            obs = observer(**enc).logits.float()
            perf = performer(**enc).logits.float()
        labels = enc.input_ids[:, 1:]
        log_ppl = torch.nn.functional.cross_entropy(
            perf[:, :-1].transpose(1, 2), labels, reduction="none"
        ).mean().item()
        x_ppl = (-(torch.softmax(obs, dim=-1) * torch.log_softmax(perf, dim=-1)).sum(-1)).mean().item()
        tokens = int(enc.input_ids.shape[1])
    except DetectorUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001
        raise DetectorUnavailable(str(exc)) from exc

    if x_ppl <= 0:
        return None
    return {"binoculars": log_ppl / x_ppl, "log_ppl": log_ppl, "x_ppl": x_ppl, "tokens": tokens}


def detect_ai_content_viet(document: dict | None, input_text: str, *, extractor=viet_binoculars_features) -> dict:
    """Mode 3 (Vietnamese text). Never raises; `available: False` lets the caller fall back."""
    try:
        segments = select_segments(document, input_text)
        language = guess_language(normalize_text(input_text)[:6000])
        results: list[dict] = []

        for seg in segments:
            feats = extractor(seg["text"])
            if feats is None:
                continue
            probability = binoculars_probability(
                feats["binoculars"], threshold=VIET_BINOCULARS_THRESHOLD, scale=VIET_BINOCULARS_SCALE
            )
            results.append({**seg, "features": feats, "probability": probability})

        summary = summarize_binoculars(
            results, language=language, model_name=f"{VIET_OBSERVER_MODEL} + {VIET_PERFORMER_MODEL} (int8)"
        )
        if not results:
            return {**summary, "method": METHOD_VIET_BINOCULARS}

        # summarize_binoculars() is written for the uncalibrated English/Qwen
        # pair: swap in this detector's threshold, confidence and reasons.
        total_words = summary["analyzed_words"]
        avg_score = sum(s["features"]["binoculars"] * s["words"] for s in results) / total_words
        threshold = VIET_BINOCULARS_THRESHOLD
        if avg_score < threshold:
            first = (
                f"Binoculars score ≈ {avg_score:.2f}, below the {threshold:.2f} threshold: relative to how "
                "surprising the topic is, the wording is as predictable as a language model's own output."
            )
        else:
            first = (
                f"Binoculars score ≈ {avg_score:.2f}, above the {threshold:.2f} threshold, which is typical of human writing."
            )
        reasons = [first]
        if summary["ai_share"] > 0:
            reasons.append(
                f"About {summary['ai_share']:.0f}% of the analysed text sits in paragraphs that individually look machine-written."
            )
        reasons.append(VIET_METHOD_NOTE)

        # Calibrated on Vietnamese, so only length lowers confidence here.
        confidence = "normal" if total_words >= MIN_TOTAL_WORDS else "low"
        level = level_for(summary["overall_score"])
        if confidence == "low" and level == "likely":
            level = "possible"

        summary.pop("binoculars_threshold", None)
        return {
            **summary,
            "method": METHOD_VIET_BINOCULARS,
            "confidence": confidence,
            "level": level,
            "binoculars_threshold": threshold,
            "reasons": reasons,
        }
    except DetectorUnavailable as exc:
        logger.warning("AI-content detection (VietBinoculars) unavailable: %s", exc)
        return {"available": False, "method": METHOD_VIET_BINOCULARS, "reason": str(exc)}
    except Exception as exc:  # noqa: BLE001
        logger.exception("AI-content detection (VietBinoculars) failed")
        return {"available": False, "method": METHOD_VIET_BINOCULARS, "reason": f"unexpected error: {exc}"}
