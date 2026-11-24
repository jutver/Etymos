"""
ai_explain.py
-------------
Explainable AI: a plain-language "why is this passage flagged" for each match.

final_report_builder._build_explanation gives every match a parameterised
sentence built from its numbers ("72% semantic similarity to 'Title' —
classified as suspicious..."). It says how *much* but not *what*. This module
replaces it with an explanation of what the two passages actually share.

Grounded, not free-form
-----------------------
A small local LLM asked to "explain this match" happily invents things (in
testing it called two identical sentences "slightly different in wording").
An explanation that is fluent but wrong is worse than none, so:

  1. FACTS are computed in code for every match: are the passages identical,
     what is the longest run of words they share (and the exact phrase), what
     share of the student's sentence it covers.
  2. A deterministic explanation is written from those facts (English or
     Vietnamese, following the student's or reader's language). It is always
     correct, needs no model, and is what every match gets by default.
  3. On-demand Gemini explanations (POST /api/reports/{id}/matches/{mid}/explain)
     use the dedicated `GEMINI_EXPLAIN_API_KEY` (fallback `GEMINI_API_KEY`) via
     per-request HTTP calls so global SDK credentials never race across threads.
     Answers are verified against grounded facts (`validate_llm_text`) before
     caching, and any error or invalid reply seamlessly falls back to step 2.
"""

from __future__ import annotations

import logging
import os
import re
import time
from typing import Any, Callable

import httpx

from ai_rewrite import _clean_output, _looks_vietnamese
from feature_flags import ensure_flag_registered, is_flag_enabled
from source_title import sanitize_source_title

logger = logging.getLogger(__name__)

EXPLAIN_FLAG_KEY = "gemini_ai_explanations"
EXPLAIN_FLAG_LABEL = "Use Gemini for AI explanations"
EXPLAIN_FLAG_DESCRIPTION = (
    "When enabled, the LLM polish step of the 'why is this flagged' explanations uses the "
    "Gemini API instead of the local Qwen2.5 model. Defaults off: the local model costs "
    "nothing per call. Either way a failure falls back to the other provider and then to "
    "the fact-based explanation, which is always present."
)

GEMINI_EXPLAIN_MODEL = os.getenv("GEMINI_EXPLAIN_MODEL", "gemini-flash-latest")
GEMINI_EXPLAIN_TIMEOUT_SECONDS = float(os.getenv("GEMINI_EXPLAIN_TIMEOUT_SECONDS", "12.0"))
GEMINI_GENERATE_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
LOCAL_EXPLAIN_MAX_NEW_TOKENS = int(os.getenv("LOCAL_EXPLAIN_MAX_NEW_TOKENS", "160"))

# Only the most serious matches get an LLM polish (when batch mode is enabled);
# the rest keep the fact-based text.
MAX_LLM_EXPLANATIONS = int(os.getenv("EXPLAIN_MAX_LLM", "8"))
# Stop asking the LLM after this long; whatever is left keeps the fact-based text.
TIME_BUDGET_SECONDS = float(os.getenv("EXPLAIN_TIME_BUDGET_SECONDS", "90"))
# A provider that fails this many times in a row is skipped for the rest of the run.
MAX_CONSECUTIVE_FAILURES = 2

MAX_EXPLANATION_CHARS = 600
# A shared run at least this long is "a shared phrase"; at least this long is "long verbatim copy".
PHRASE_MIN_WORDS = 4
VERBATIM_MIN_WORDS = 8
# Covering this much of the student's sentence counts as "the whole sentence".
WHOLE_SENTENCE_COVERAGE = 0.9
_MAX_TOKENS_FOR_ALIGNMENT = 160

SYSTEM_PROMPT = (
    "You are a plagiarism-report assistant. You explain, in plain language a student "
    "understands, why a passage of their document was flagged against a published source. "
    "You are accurate, calm and specific to this passage, you never accuse the student of "
    "cheating, you never contradict the verified facts you are given, and you reply with "
    "the explanation only: plain text, no markdown, no bullet points, no labels."
)

_LABEL_HINTS = {
    "likely_plagiarism": "classified as likely plagiarism (the most serious class)",
    "suspicious": "classified as suspicious (needs a human look)",
    "common_academic_definition": "classified as a common academic definition (usually acceptable, but should be cited)",
}

_WORD = re.compile(r"\w+", re.UNICODE)


class ExplainUnavailable(RuntimeError):
    """Neither provider could produce an explanation."""


def get_gemini_explain_api_key() -> str:
    """Dedicated credential for explanations; falls back to GEMINI_API_KEY only when unset."""
    return (os.getenv("GEMINI_EXPLAIN_API_KEY") or os.getenv("GEMINI_API_KEY") or "").strip()


def get_gemini_explain_model() -> str:
    return (os.getenv("GEMINI_EXPLAIN_MODEL") or GEMINI_EXPLAIN_MODEL or "gemini-flash-latest").strip()


def get_gemini_explain_timeout() -> float:
    raw = os.getenv("GEMINI_EXPLAIN_TIMEOUT_SECONDS")
    if raw:
        try:
            val = float(raw)
            if val > 0:
                return val
        except ValueError:
            pass
    return GEMINI_EXPLAIN_TIMEOUT_SECONDS


def register_flag() -> None:
    """Make the flag visible in the admin portal. Safe on every startup."""
    ensure_flag_registered(
        EXPLAIN_FLAG_KEY,
        EXPLAIN_FLAG_LABEL,
        EXPLAIN_FLAG_DESCRIPTION,
        default_enabled=False,
    )


def is_gemini_explanations_enabled() -> bool:
    return is_flag_enabled(EXPLAIN_FLAG_KEY, default=False)


# ---------------------------------------------------------------------------
# Facts (pure)
# ---------------------------------------------------------------------------

def _words(text: str) -> list[tuple[str, int, int]]:
    """(lowercased word, start, end) for each word, so a matched run can be
    quoted back in the student's own casing and punctuation."""
    return [(m.group().lower(), m.start(), m.end()) for m in _WORD.finditer(text or "")]


def _longest_common_run(a: list[str], b: list[str]) -> tuple[int, int]:
    """(length, start index in `a`) of the longest common contiguous word run."""
    a, b = a[:_MAX_TOKENS_FOR_ALIGNMENT], b[:_MAX_TOKENS_FOR_ALIGNMENT]
    best_len, best_start = 0, 0
    previous = [0] * (len(b) + 1)
    for i in range(1, len(a) + 1):
        current = [0] * (len(b) + 1)
        for j in range(1, len(b) + 1):
            if a[i - 1] == b[j - 1]:
                current[j] = previous[j - 1] + 1
                if current[j] > best_len:
                    best_len, best_start = current[j], i - current[j]
        previous = current
    return best_len, best_start


def compute_facts(match: dict) -> dict:
    """Verifiable facts about how the student's sentence relates to the source."""
    student = match.get("input_sentence") or ""
    source = match.get("source_sentence") or ""
    a_tokens, b_tokens = _words(student), _words(source)
    a, b = [w for w, _, _ in a_tokens], [w for w, _, _ in b_tokens]

    run_len, run_start = _longest_common_run(a, b)
    phrase = ""
    if run_len:
        first, last = a_tokens[run_start], a_tokens[run_start + run_len - 1]
        phrase = student[first[1]:last[2]]

    coverage = run_len / len(a) if a else 0.0
    return {
        "identical": bool(a) and a == b,
        "shared_words": run_len,
        "shared_phrase": phrase,
        "coverage": coverage,
        "whole_sentence": bool(a) and (a == b or coverage >= WHOLE_SENTENCE_COVERAGE),
        "student_words": len(a),
        "semantic_pct": _pct(match.get("semantic_similarity")),
        "overlap_pct": _pct(match.get("word_overlap")),
    }


def _pct(value) -> int:
    try:
        return max(0, min(100, round(float(value) * 100)))
    except (TypeError, ValueError):
        return 0


def _clean_match_title(match: dict, limit: int = 80) -> str:
    raw = (match.get("source_title") or "").strip()
    if not raw:
        return ""
    is_acad = match.get("source_kind") != "web"
    cleaned = sanitize_source_title(raw, is_academic=is_acad, max_length=limit) or raw
    return _quote(cleaned, limit)


def _normalize_language(language: str | None) -> str | None:
    if not language:
        return None
    low = language.strip().lower()
    if low in ("vi", "vietnamese"):
        return "Vietnamese"
    if low in ("en", "english"):
        return "English"
    return None


def answer_language(match: dict, language: str | None = None) -> str:
    """Explain in explicit UI language when supplied, otherwise match the student's language."""
    explicit = _normalize_language(language)
    if explicit:
        return explicit
    return "Vietnamese" if _looks_vietnamese(match.get("input_sentence") or "") else "English"


def _quote(phrase: str, limit: int = 110) -> str:
    phrase = " ".join((phrase or "").split())
    return phrase if len(phrase) <= limit else phrase[: limit - 1].rstrip() + "…"


def passage_excerpt(text: str | None, limit: int = 75) -> str:
    return _quote(text or "", limit)


_TEXT = {
    "English": {
        "identical": (
            "This {total}-word sentence (\"{excerpt}\") is identical to the source{title} ({semantic}% similarity): "
            "every word matches, so it reads as copied word for word. "
            "If you want to keep it, put it in quotation marks and cite the source; otherwise say the idea in your own words and structure."
        ),
        "whole": (
            "Almost this whole sentence appears in the source{title} in the same words ({shared} of your {total} words in a row). "
            "That reads as direct copying. Quote and cite it, or restate the idea in your own words."
        ),
        "verbatim": (
            "Your text shares a {shared}-word run with the source{title}: \"{phrase}\". "
            "Reusing that many words in a row is a strong sign of direct copying, so quote and cite it or reword it."
        ),
        "phrase": (
            "Your text and the source{title} share the phrase \"{phrase}\" ({shared} words in a row), and the sentence as a whole is {semantic}% similar in meaning. "
            "Reword the surrounding sentence, or quote and cite the source."
        ),
        "reworded": (
            "The wording differs from the source{title}, but the meaning is {semantic}% the same and the sentence follows the source's structure. "
            "Close paraphrases like this are still flagged: restructure the sentence in your own way and cite the source."
        ),
        "definition": " This looks like a standard definition that many authors phrase similarly; it is usually acceptable if you cite where the definition comes from.",
        "suspicious": " It deserves a closer look.",
        "likely": " It is among the strongest matches in your document.",
        "title": ' "{title}"',
    },
    "Vietnamese": {
        "identical": (
            "Câu dài {total} từ này (\"{excerpt}\") giống hệt nguồn{title} (tương đồng {semantic}%): "
            "từng từ đều trùng, nên đọc lên như sao chép nguyên văn. "
            "Nếu muốn giữ, hãy đặt trong dấu ngoặc kép và trích dẫn nguồn; nếu không, hãy diễn đạt lại ý bằng lời và cấu trúc của bạn."
        ),
        "whole": (
            "Gần như cả câu này xuất hiện trong nguồn{title} với đúng từ ngữ ({shared}/{total} từ liên tiếp trùng nhau). "
            "Đây là dấu hiệu sao chép trực tiếp. Hãy trích dẫn nguyên văn kèm nguồn, hoặc diễn đạt lại ý bằng lời của bạn."
        ),
        "verbatim": (
            "Văn bản của bạn trùng với nguồn{title} một đoạn dài {shared} từ liên tiếp: \"{phrase}\". "
            "Trùng nhiều từ liền nhau như vậy là dấu hiệu mạnh của việc sao chép, hãy trích dẫn kèm nguồn hoặc viết lại."
        ),
        "phrase": (
            "Văn bản của bạn và nguồn{title} có chung cụm \"{phrase}\" ({shared} từ liên tiếp), và toàn câu giống nhau {semantic}% về nghĩa. "
            "Hãy viết lại phần câu xung quanh, hoặc trích dẫn kèm nguồn."
        ),
        "reworded": (
            "Từ ngữ khác với nguồn{title}, nhưng ý nghĩa giống {semantic}% và câu đi theo đúng cấu trúc của nguồn. "
            "Kiểu diễn đạt lại sát như vậy vẫn bị đánh dấu: hãy tổ chức lại câu theo cách riêng của bạn và trích dẫn nguồn."
        ),
        "definition": " Đây có vẻ là một định nghĩa quen thuộc mà nhiều tác giả diễn đạt tương tự; thường vẫn chấp nhận được nếu bạn ghi rõ nguồn của định nghĩa.",
        "suspicious": " Cần xem xét kỹ hơn.",
        "likely": " Đây là một trong những đoạn trùng đáng chú ý nhất trong tài liệu của bạn.",
        "title": ' "{title}"',
    },
}


def facts_explanation(match: dict, facts: dict | None = None, *, language: str | None = None) -> str:
    """Deterministic, always-correct explanation built only from the facts."""
    facts = facts or compute_facts(match)
    lang = answer_language(match, language)
    t = _TEXT[lang]
    title_raw = _clean_match_title(match, 80)
    title = t["title"].format(title=title_raw) if title_raw else ""

    shared, phrase = facts["shared_words"], _quote(facts["shared_phrase"])
    excerpt = passage_excerpt(match.get("input_sentence") or "", 75)
    fields = dict(
        title=title,
        shared=shared,
        total=facts["student_words"],
        phrase=phrase,
        semantic=facts["semantic_pct"],
        excerpt=excerpt,
    )

    if facts["identical"]:
        body = t["identical"]
    elif match.get("label") == "common_academic_definition" and shared < PHRASE_MIN_WORDS:
        # Nothing was copied in a checkable way; "restructure your sentence" advice
        # would just contradict the reassurance below.
        return t["definition"].strip() + f" ({facts['semantic_pct']}% similar in meaning{title and ' to' + title}.)"
    elif facts["whole_sentence"] and shared >= PHRASE_MIN_WORDS:
        body = t["whole"]
    elif shared >= VERBATIM_MIN_WORDS:
        body = t["verbatim"]
    elif shared >= PHRASE_MIN_WORDS:
        body = t["phrase"]
    else:
        body = t["reworded"]

    label = match.get("label")
    suffix = (
        t["definition"]
        if label == "common_academic_definition"
        else t["likely"]
        if label == "likely_plagiarism"
        else t["suspicious"]
        if label == "suspicious"
        else ""
    )
    return (body.format(**fields) + suffix).strip()


def explanation_facts(match: dict, facts: dict | None = None) -> dict:
    """
    The same choice facts_explanation() makes, as data instead of a sentence:
    which template ("kind") plus the values it fills in. Lets the web app write
    the explanation in the *reader's* UI language rather than the student's.
    """
    facts = facts or compute_facts(match)
    shared = facts["shared_words"]
    label = match.get("label") or ""
    if facts["identical"]:
        kind = "identical"
    elif label == "common_academic_definition" and shared < PHRASE_MIN_WORDS:
        kind = "definition_only"
    elif facts["whole_sentence"] and shared >= PHRASE_MIN_WORDS:
        kind = "whole"
    elif shared >= VERBATIM_MIN_WORDS:
        kind = "verbatim"
    elif shared >= PHRASE_MIN_WORDS:
        kind = "phrase"
    else:
        kind = "reworded"
    return {
        "kind": kind,
        "label": label,
        "title": _clean_match_title(match, 80),
        "shared": shared,
        "total": facts["student_words"],
        "phrase": _quote(facts["shared_phrase"]),
        "semantic": facts["semantic_pct"],
        "excerpt": passage_excerpt(match.get("input_sentence") or "", 75),
    }


# ---------------------------------------------------------------------------
# LLM polish: prompt, validation (pure)
# ---------------------------------------------------------------------------

def _clip(text: str, limit: int = 700) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def build_prompt(match: dict, facts: dict | None = None, *, language: str | None = None) -> str:
    facts = facts or compute_facts(match)
    label = match.get("label") or ""
    title = _clean_match_title(match, 120) or "an unnamed source"

    if facts["identical"]:
        shared_line = (
            f"The two passages are IDENTICAL, word for word ({facts['student_words']} words in the student's sentence)."
        )
    elif facts["shared_words"] >= PHRASE_MIN_WORDS:
        shared_line = (
            f"The longest run of words they share is {facts['shared_words']} words: \"{_quote(facts['shared_phrase'])}\" "
            f"(covering {round(facts['coverage'] * 100)}% of the student's {facts['student_words']}-word sentence)."
        )
    else:
        shared_line = (
            f"They share no run of {PHRASE_MIN_WORDS} or more identical words; the overlap is in meaning and structure, "
            "not in copied wording."
        )

    overlap_line = (
        f"Meaning similarity: {facts['semantic_pct']}%. "
        + (f"Shared words overall: {facts['overlap_pct']}%. " if match.get("word_overlap") is not None else "")
        + f"The match is {_LABEL_HINTS.get(label, 'classified as a possible match')}."
    )

    return f"""
A passage from a student's document was flagged as similar to a published source.

VERIFIED FACTS (ground truth; never contradict them, and do not quote anything that is not in the two passages or the source title):
- {shared_line}
- {overlap_line}
- Source: {title}

STUDENT TEXT:
\"\"\"{_clip(match.get("input_sentence"))}\"\"\"

SOURCE TEXT:
\"\"\"{_clip(match.get("source_sentence"))}\"\"\"

Write 2 or 3 short sentences (under 75 words in total) tailored specifically to this passage that:
1. identify the specific claim, concept, or wording shared between this passage and the source, consistent with the verified facts above;
2. explain why it is flagged and how seriously to treat it, without exaggerating;
3. give one concrete fix (such as quoting with attribution or restructuring the sentence in the student's own phrasing).

Write the answer in {answer_language(match, language)}. Plain text only.
""".strip()


_QUOTED = re.compile(r"[\"“”«»]([^\"“”«»]{3,})[\"“”«»]")
_CLAIMS_VERBATIM = re.compile(
    r"verbatim|word[- ]for[- ]word|copied exactly|exact(ly)? (the same|copy)|identical|giống hệt|nguyên văn|sao chép nguyên",
    re.IGNORECASE,
)
_CLAIMS_DIFFERENT = re.compile(
    r"\b(?:differ(?:s|ed|ing)?|different|paraphras(?:e|ed|ing)|reworded|rephrased)\b"
    r"|khác\s+(?:nhau|với|so với|biệt)"
    r"|(?:được|bị|dường như|là|chỉ)\s+(?:diễn đạt lại|viết lại)",
    re.IGNORECASE,
)


def _normalized(text: str) -> str:
    return " ".join(w for w, _, _ in _words(text))


def validate_llm_text(text: str, match: dict, facts: dict) -> str | None:
    """Reason the LLM's answer must be rejected, or None if it is acceptable."""
    if not text:
        return "empty"
    haystack = " || ".join(
        filter(
            None,
            [
                _normalized(match.get("input_sentence") or ""),
                _normalized(match.get("source_sentence") or ""),
                _normalized(_clean_match_title(match, 160)),
                _normalized(match.get("source_title") or ""),
            ],
        )
    )
    for quoted in _QUOTED.findall(text):
        norm_quote = _normalized(quoted)
        if norm_quote and norm_quote not in haystack:
            return f"quotes text that is not in either passage: {quoted!r}"
    if facts["identical"] and _CLAIMS_DIFFERENT.search(text):
        return "calls identical text different"
    if not facts["identical"] and not facts["whole_sentence"] and facts["shared_words"] < VERBATIM_MIN_WORDS:
        if _CLAIMS_VERBATIM.search(text):
            return "claims verbatim copying the facts do not support"
    return None


def clean_explanation(text: str) -> str:
    cleaned = _clean_output(text)
    cleaned = " ".join(cleaned.split())
    if len(cleaned) > MAX_EXPLANATION_CHARS:
        cut = cleaned[:MAX_EXPLANATION_CHARS]
        # end on a sentence boundary when there is one
        end = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
        cleaned = cut[: end + 1] if end > 120 else cut.rstrip() + "…"
    return cleaned


def select_for_llm(matches: list[dict], limit: int) -> list[dict]:
    """The first `limit` matches that have both texts to explain from."""
    chosen: list[dict] = []
    for match in matches:
        if len(chosen) >= limit:
            break
        if (match.get("input_sentence") or "").strip() and (match.get("source_sentence") or "").strip():
            chosen.append(match)
    return chosen


# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------

def _extract_gemini_text(payload: dict[str, Any]) -> str:
    candidates = payload.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        return ""
    first = candidates[0] if isinstance(candidates[0], dict) else {}
    content = first.get("content") if isinstance(first.get("content"), dict) else {}
    parts = content.get("parts") if isinstance(content.get("parts"), list) else []
    texts = [str(p.get("text") or "") for p in parts if isinstance(p, dict) and p.get("text")]
    return clean_explanation(" ".join(texts))


def explain_with_gemini_http(
    match: dict,
    facts: dict | None = None,
    *,
    language: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
    timeout: float | None = None,
    http_client: Any = None,
) -> str:
    """Thread-safe Gemini REST call using dedicated `GEMINI_EXPLAIN_API_KEY` header."""
    resolved_key = (api_key if api_key is not None else get_gemini_explain_api_key()).strip()
    if not resolved_key:
        raise ExplainUnavailable("GEMINI_EXPLAIN_API_KEY / GEMINI_API_KEY is not set.")

    resolved_model = (model or get_gemini_explain_model()).strip()
    resolved_timeout = float(timeout if timeout is not None else get_gemini_explain_timeout())
    prompt = build_prompt(match, facts, language=language)

    url = GEMINI_GENERATE_URL.format(model=resolved_model)
    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": resolved_key,
    }
    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.25, "maxOutputTokens": 240},
    }

    caller = http_client.post if http_client is not None else httpx.post
    try:
        resp = caller(url, headers=headers, json=body, timeout=resolved_timeout)
    except Exception as exc:  # noqa: BLE001
        raise ExplainUnavailable(f"Gemini explanation HTTP request failed: {exc}") from exc

    status_code = getattr(resp, "status_code", 500)
    if status_code >= 400:
        raise ExplainUnavailable(f"Gemini explanation HTTP {status_code}")

    try:
        payload = resp.json()
    except Exception as exc:  # noqa: BLE001
        raise ExplainUnavailable("Invalid JSON from Gemini explanation endpoint.") from exc

    text = _extract_gemini_text(payload)
    if not text:
        raise ExplainUnavailable("Gemini returned an empty explanation.")
    return text


def explain_single_match(
    match: dict,
    *,
    language: str = "en",
    http_client: Any = None,
) -> dict[str, Any]:
    """Generate an explanation for one match via Gemini, falling back to enriched facts."""
    facts = compute_facts(match)
    model_used = get_gemini_explain_model()
    has_texts = bool((match.get("input_sentence") or "").strip())

    if has_texts:
        try:
            text = explain_with_gemini_http(
                match,
                facts,
                language=language,
                model=model_used,
                http_client=http_client,
            )
            rejection = validate_llm_text(text, match, facts)
            if rejection:
                logger.info("Rejected on-demand Gemini explanation: %s", rejection)
            else:
                return {"explanation": text, "source": "llm:gemini", "model": model_used}
        except Exception as exc:  # noqa: BLE001
            logger.warning("On-demand Gemini explanation fallback to facts: %s", exc)

    return {
        "explanation": facts_explanation(match, facts, language=language),
        "source": "facts",
        "model": None,
    }


def explain_with_gemini(match: dict, facts: dict | None = None) -> str:
    return explain_with_gemini_http(match, facts)


def explain_with_local_model(match: dict, facts: dict | None = None) -> str:
    import torch

    import gpu_models
    import llm_metadata

    with llm_metadata.local_model() as (tokenizer, model):
        prompt = tokenizer.apply_chat_template(
            [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": build_prompt(match, facts)}],
            tokenize=False,
            add_generation_prompt=True,
        )
        inputs = tokenizer(prompt, return_tensors="pt", truncation=True, max_length=2048).to(model.device)

        def generate():
            with torch.no_grad():
                return model.generate(
                    **inputs,
                    max_new_tokens=LOCAL_EXPLAIN_MAX_NEW_TOKENS,
                    do_sample=False,
                    temperature=None,
                    top_p=None,
                    top_k=None,
                    pad_token_id=tokenizer.eos_token_id,
                )

        outputs = gpu_models.retry_on_oom(generate)
        generated = outputs[0][inputs["input_ids"].shape[-1]:]
        return clean_explanation(tokenizer.decode(generated, skip_special_tokens=True))


PROVIDERS: dict[str, Callable[..., str]] = {
    "gemini": explain_with_gemini,
    "local": explain_with_local_model,
}


def explain_matches(
    matches: list[dict],
    *,
    providers: dict[str, Callable[..., str]] | None = None,
    order: list[str] | None = None,
    limit: int = MAX_LLM_EXPLANATIONS,
    time_budget: float = TIME_BUDGET_SECONDS,
    clock: Callable[[], float] = time.monotonic,
    use_llm: bool = True,
) -> dict:
    """
    Give every match a fact-based explanation, then let an LLM polish the most
    serious ones. Each match ends with `explanation_source`: "facts" or
    "llm:<provider>". Returns summary counts. Never raises.
    """
    providers = providers or PROVIDERS

    facts_by_id: dict[int, dict] = {}
    for match in matches:
        try:
            facts = compute_facts(match)
            facts_by_id[id(match)] = facts
            if (match.get("input_sentence") or "").strip() and (match.get("source_sentence") or "").strip():
                match["explanation"] = facts_explanation(match, facts)
                match["explanation_source"] = "facts"
                match["explanation_facts"] = explanation_facts(match, facts)
            else:
                match.setdefault("explanation_source", "template")
        except Exception:  # noqa: BLE001 — keep whatever explanation the match already had
            logger.exception("Could not build a fact-based explanation")
            match.setdefault("explanation_source", "template")

    if not use_llm:
        return {"upgraded": 0, "total": len(matches), "attempted_limit": 0}

    try:
        if order is None:
            order = ["gemini", "local"] if is_gemini_explanations_enabled() else ["local", "gemini"]
        order = [name for name in order if name in providers]
    except Exception:  # noqa: BLE001 — a flag read must never block the check
        logger.exception("Could not read the explanations flag; using default provider order.")
        order = [name for name in ("local", "gemini") if name in providers]

    failures = {name: 0 for name in order}
    upgraded = 0
    started = clock()

    for match in select_for_llm(matches, limit):
        if clock() - started > time_budget:
            logger.info("AI explanation time budget reached; remaining matches keep the fact-based text.")
            break
        facts = facts_by_id.get(id(match)) or compute_facts(match)
        for name in order:
            if failures[name] >= MAX_CONSECUTIVE_FAILURES:
                continue
            try:
                text = providers[name](match, facts)
                rejection = validate_llm_text(text, match, facts)
                if rejection:
                    # A model that talks nonsense is not a *provider failure* (it is
                    # up), so do not count it toward the skip threshold; just keep
                    # the fact-based text for this match.
                    logger.info("Rejected %s explanation: %s", name, rejection)
                    break
                match["explanation"] = text
                match["explanation_source"] = f"llm:{name}"
                # The LLM text replaces the fact template, so the UI must show it as is.
                match.pop("explanation_facts", None)
                failures[name] = 0
                upgraded += 1
                break
            except Exception as exc:  # noqa: BLE001 — try the next provider, else keep the fact-based text
                failures[name] += 1
                logger.warning("AI explanation via %s failed: %s", name, exc)

    return {"upgraded": upgraded, "total": len(matches), "attempted_limit": limit}
