"""
ai_rewrite.py
-------------
AI Rewrite, on the local Qwen2.5 model by default, switchable to the
Gemini API from the admin portal.

This deliberately mirrors the existing metadata-extraction toggle
(llm_metadata.is_gemini_metadata_extraction_enabled): same Supabase
`feature_flags` table, same short-lived cache, same "local is the default
because the VPS has a GPU and local costs nothing per call" stance. It
reuses the same lazily-loaded Qwen weights rather than loading a second
model — the first rewrite after a metadata extraction is warm.

Flag: `gemini_ai_rewrite` (off => local Qwen, on => Gemini API).
"""

from __future__ import annotations

import logging
import os
import re

from feature_flags import ensure_flag_registered, is_flag_enabled

logger = logging.getLogger(__name__)

AI_REWRITE_FLAG_KEY = "gemini_ai_rewrite"
AI_REWRITE_FLAG_LABEL = "Use Gemini for AI rewrite"
AI_REWRITE_FLAG_DESCRIPTION = (
    "When enabled, /api/ai/rewrite calls the Gemini API instead of the local "
    "Qwen2.5 model. Defaults off: the VPS has a GPU, so the local model runs "
    "at no per-call cost. Mirrors the gemini_metadata_extraction flag."
)

GEMINI_REWRITE_MODEL = os.getenv("GEMINI_REWRITE_MODEL", "gemini-flash-latest")

# Local generation budget. Rewrites are a sentence or two, so this is
# deliberately much smaller than the metadata extraction budget.
LOCAL_REWRITE_MAX_NEW_TOKENS = int(os.getenv("LOCAL_REWRITE_MAX_NEW_TOKENS", "320"))


class RewriteUnavailable(RuntimeError):
    """Neither the local model nor the Gemini API could serve a rewrite."""


def register_flag() -> None:
    """Make the flag visible in the admin portal's Feature Flags screen.
    Safe to call on every startup; never overwrites an admin's choice."""
    ensure_flag_registered(
        AI_REWRITE_FLAG_KEY,
        AI_REWRITE_FLAG_LABEL,
        AI_REWRITE_FLAG_DESCRIPTION,
        default_enabled=False,
    )


def is_gemini_ai_rewrite_enabled() -> bool:
    """True => use the Gemini API. False (the default) => local Qwen."""
    return is_flag_enabled(AI_REWRITE_FLAG_KEY, default=False)


# The prompts are written in English ON PURPOSE. They used to be Vietnamese, and
# models answer in the language of the instructions: an English passage plus a
# Vietnamese prompt regularly came back as a Vietnamese rewrite. Keep the
# instructions in English and the language rule explicit.
REWRITE_SYSTEM_PROMPT = (
    "You are an expert academic editor. You rewrite passages from students' "
    "documents so that they no longer overlap with a published source, while "
    "keeping their meaning exactly the same. You always write in English. You "
    "reply with the rewritten passage only — no quotation marks, labels, "
    "markdown or explanations."
)


def build_rewrite_prompt(input_sentence: str, source_sentence: str, *, strict: bool = False) -> str:
    """User-turn prompt shared by the Gemini and local-Qwen paths.

    `strict` adds a final reminder about the language; it is used for the one
    retry after a reply came back in the wrong language.
    """
    prompt = f"""
A passage in a student's academic document was flagged as too similar to a published source. Rewrite the passage so it no longer overlaps with the source, while saying exactly the same thing.

SOURCE TEXT (what the passage was flagged against; do not reuse its wording):
\"\"\"{source_sentence}\"\"\"

PASSAGE TO REWRITE (the student's text):
\"\"\"{input_sentence}\"\"\"

Rules:
1. Write the rewritten passage in English only, even if the passage or the source contains text in another language.
2. Keep the meaning exactly the same. Keep every fact, claim, number, unit, named entity, model/dataset/method name, acronym and citation marker (such as [12] or (Smith et al., 2020)) unchanged. Do not add, remove, weaken or strengthen any claim, and do not add information that is not in the passage.
3. Avoid plagiarism by genuinely restructuring, not by swapping a few synonyms: change the sentence structure and the order of the ideas (for example switch active and passive voice, reorder clauses, or merge or split sentences) and choose different wording. Do not reuse any run of four or more consecutive words from the source text, except for technical terms, proper names and standard phrases that cannot be reworded (for example "hate speech detection" or "F1-score").
4. Keep a formal academic tone, and keep the length close to the original (within roughly 20%).
5. The text was extracted from a PDF, so it may contain stray symbols (such as •), words broken across lines (such as "architec- ture") or odd spacing. Quietly fix these and never reproduce them.

Output only the rewritten passage as plain text: no quotation marks, no labels such as "Rewritten:", no explanation, no alternatives.
""".strip()

    if strict:
        prompt += "\n\nIMPORTANT: your previous answer was not in English. Reply in English only."

    return prompt


# Letters that only occur in Vietnamese (plus the tone-marked vowels). English
# text almost never contains them; a stray "é" or "à" from a loanword is far
# below the ratio threshold used in `_looks_vietnamese`.
_VIETNAMESE_LETTERS = set(
    "ăâđêôơư"
    "àáảãạằắẳẵặầấẩẫậ"
    "èéẻẽẹềếểễệ"
    "ìíỉĩị"
    "òóỏõọồốổỗộờớởỡợ"
    "ùúủũụừứửữự"
    "ỳýỷỹỵ"
)


def _looks_vietnamese(text: str, threshold: float = 0.03) -> bool:
    """True when `text` reads as Vietnamese rather than English.

    Vietnamese has diacritic-bearing letters in a large share of its words, so
    even a short reply crosses a 3% ratio of such letters, while English prose
    (with at most an occasional loanword) stays near zero.
    """
    letters = [c for c in text.lower() if c.isalpha()]
    if not letters:
        return False
    vietnamese = sum(1 for c in letters if c in _VIETNAMESE_LETTERS)
    return vietnamese / len(letters) >= threshold


_LEADING_LABEL = re.compile(
    r"^\s*(?:here(?:'s| is)[^:\n]{0,60}|(?:the\s+)?rewritten(?:\s+(?:passage|text|version))?|rewrite)\s*:\s*",
    re.IGNORECASE,
)


_LEADING_BULLETS = re.compile(r"^[\s•·▪●◦■□‣]+")


def _clean_output(text: str) -> str:
    """Strip the wrapping quotes, stray markdown fences and "Rewritten:"-style
    labels that models like to add around their answer."""
    cleaned = (text or "").strip()

    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[-1]
        if cleaned.endswith("```"):
            cleaned = cleaned[: -3]
        cleaned = cleaned.strip()

    cleaned = _LEADING_LABEL.sub("", cleaned, count=1).strip()
    # PDF list bullets ("•") get copied over by small models even when told not to.
    cleaned = _LEADING_BULLETS.sub("", cleaned).strip()

    if len(cleaned) >= 2 and cleaned[0] == cleaned[-1] and cleaned[0] in "\"'“”":
        cleaned = cleaned[1:-1].strip()

    return cleaned


def rewrite_with_gemini(input_sentence: str, source_sentence: str, *, strict: bool = False) -> str:
    import google.generativeai as genai

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RewriteUnavailable("GEMINI_API_KEY is not set.")

    genai.configure(api_key=api_key)
    # The system instruction carries the "always English" rule at the highest
    # priority; the user turn repeats it next to the concrete rewriting rules.
    model = genai.GenerativeModel(GEMINI_REWRITE_MODEL, system_instruction=REWRITE_SYSTEM_PROMPT)
    response = model.generate_content(build_rewrite_prompt(input_sentence, source_sentence, strict=strict))

    return _clean_output(getattr(response, "text", "") or "")


def rewrite_with_local_model(input_sentence: str, source_sentence: str, *, strict: bool = False) -> str:
    """Run the rewrite on the local Qwen2.5 model.

    Reuses llm_metadata's lazily-loaded singleton weights (the same model
    the metadata extractor uses) via its tokenizer/model handles, with a
    rewrite-appropriate system prompt instead of the JSON-only one.
    """
    import llm_metadata

    llm_metadata._ensure_local_model_loaded()

    tokenizer = llm_metadata._tokenizer
    model = llm_metadata._model

    if tokenizer is None or model is None:
        raise RewriteUnavailable("Local model failed to load.")

    messages = [
        {"role": "system", "content": REWRITE_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": build_rewrite_prompt(input_sentence, source_sentence, strict=strict),
        },
    ]

    prompt = tokenizer.apply_chat_template(
        messages,
        tokenize=False,
        add_generation_prompt=True,
    )

    inputs = tokenizer(
        prompt,
        return_tensors="pt",
        truncation=True,
        max_length=4096,
    ).to(model.device)

    import torch

    with torch.no_grad():
        outputs = model.generate(
            **inputs,
            max_new_tokens=LOCAL_REWRITE_MAX_NEW_TOKENS,
            do_sample=True,
            temperature=0.7,
            top_p=0.9,
            pad_token_id=tokenizer.eos_token_id,
        )

    generated = outputs[0][inputs["input_ids"].shape[-1]:]

    return _clean_output(tokenizer.decode(generated, skip_special_tokens=True))


def rewrite_sentence(input_sentence: str, source_sentence: str) -> dict:
    """
    Rewrite `input_sentence`, routed by the `gemini_ai_rewrite` flag.

    Falls back to the other provider if the selected one fails, so a
    missing GPU (or a missing API key) degrades instead of 500-ing.

    Returns {"rewritten_text", "provider", "model", "fallback_used"}.
    """
    use_gemini = is_gemini_ai_rewrite_enabled()

    primary = "gemini" if use_gemini else "local"
    order = ["gemini", "local"] if use_gemini else ["local", "gemini"]

    errors: list[str] = []

    for provider in order:
        try:
            if provider == "gemini":
                generate = rewrite_with_gemini
                model_name = GEMINI_REWRITE_MODEL
            else:
                generate = rewrite_with_local_model
                from config import LLM_MODEL_NAME
                model_name = LLM_MODEL_NAME

            text = generate(input_sentence, source_sentence)

            # The rewrite must be English. If it came back Vietnamese anyway,
            # ask once more with an explicit reminder; if it is still not
            # English, treat this provider as failed so the other one gets a go.
            if text and _looks_vietnamese(text):
                logger.info("AI rewrite via %s came back in Vietnamese; retrying once.", provider)
                text = generate(input_sentence, source_sentence, strict=True)
                if text and _looks_vietnamese(text):
                    raise RewriteUnavailable(f"{provider} did not return an English rewrite.")

            if not text:
                raise RewriteUnavailable(f"{provider} returned an empty rewrite.")

            return {
                "rewritten_text": text,
                "provider": provider,
                "model": model_name,
                "fallback_used": provider != primary,
            }
        except Exception as exc:
            errors.append(f"{provider}: {exc}")
            logger.warning("AI rewrite via %s failed: %s", provider, exc)

    raise RewriteUnavailable("; ".join(errors) or "No rewrite provider available.")
