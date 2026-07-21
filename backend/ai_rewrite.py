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


def build_rewrite_prompt(input_sentence: str, source_sentence: str) -> str:
    return f"""
Viết lại đoạn văn bị đánh dấu đạo văn, giữ nguyên ý nghĩa học thuật.
Lưu ý: Văn bản này được trích xuất từ PDF nên có thể bị lỗi ký tự lạ (•). Hãy bỏ qua chúng.

[VĂN BẢN GỐC]: "{source_sentence}"
[ĐOẠN VĂN NGƯỜI DÙNG]: "{input_sentence}"

Yêu cầu: Viết lại đoạn văn người dùng, paraphrase để giảm đạo văn, tuyệt đối không trả về ký tự lạ.
Chỉ trả về nội dung đã viết lại, không giải thích.
""".strip()


def _clean_output(text: str) -> str:
    """Strip the wrapping quotes and stray markdown fences small models
    like to add around their answer."""
    cleaned = (text or "").strip()

    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[-1]
        if cleaned.endswith("```"):
            cleaned = cleaned[: -3]
        cleaned = cleaned.strip()

    if len(cleaned) >= 2 and cleaned[0] == cleaned[-1] and cleaned[0] in "\"'“”":
        cleaned = cleaned[1:-1].strip()

    return cleaned


def rewrite_with_gemini(input_sentence: str, source_sentence: str) -> str:
    import google.generativeai as genai

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RewriteUnavailable("GEMINI_API_KEY is not set.")

    genai.configure(api_key=api_key)
    model = genai.GenerativeModel(GEMINI_REWRITE_MODEL)
    response = model.generate_content(build_rewrite_prompt(input_sentence, source_sentence))

    return _clean_output(getattr(response, "text", "") or "")


def rewrite_with_local_model(input_sentence: str, source_sentence: str) -> str:
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
        {
            "role": "system",
            "content": (
                "Bạn là trợ lý học thuật. Bạn viết lại (paraphrase) đoạn văn "
                "để giảm trùng lặp, giữ nguyên ý nghĩa. Chỉ trả về đoạn văn đã "
                "viết lại, không giải thích, không thêm dấu ngoặc kép."
            ),
        },
        {
            "role": "user",
            "content": build_rewrite_prompt(input_sentence, source_sentence),
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
                text = rewrite_with_gemini(input_sentence, source_sentence)
                model_name = GEMINI_REWRITE_MODEL
            else:
                text = rewrite_with_local_model(input_sentence, source_sentence)
                from config import LLM_MODEL_NAME
                model_name = LLM_MODEL_NAME

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
