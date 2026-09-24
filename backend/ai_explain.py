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
     Vietnamese, following the student's language). It is always correct, needs
     no model, and is what every match gets by default.
  3. For the most serious matches an LLM may rewrite it more fluently. It is
     shown the facts as ground truth, and its answer is REJECTED (keeping the
     deterministic text) if it quotes a phrase that is not in either passage,
     calls identical text different, or calls reworded text word-for-word.

Provider routing mirrors ai_rewrite: local Qwen by default, Gemini when the
`gemini_ai_explanations` flag is on, each falling back to the other. Nothing
here can fail or stall a check: LLM work is bounded by a match cap and a time
budget, and every failure just leaves the deterministic explanation.
"""

from __future__ import annotations

import logging
import os
import re
import time
from typing import Callable

from ai_rewrite import _clean_output, _looks_vietnamese
from feature_flags import ensure_flag_registered, is_flag_enabled

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
LOCAL_EXPLAIN_MAX_NEW_TOKENS = int(os.getenv("LOCAL_EXPLAIN_MAX_NEW_TOKENS", "160"))

# Only the most serious matches get an LLM polish (the list arrives sorted
# likely_plagiarism first, then by similarity); the rest keep the fact-based text.
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
    "You are accurate, calm and specific, you never accuse the student of cheating, you never "
    "contradict the verified facts you are given, and you reply with the explanation only: "
    "plain text, no markdown, no bullet points, no labels."
)

_LABEL_HINTS = {
    "likely_plagiarism": "classified as likely plagiarism (the most serious class)",
    "suspicious": "classified as suspicious (needs a human look)",
    "common_academic_definition": "classified as a common academic definition (usually acceptable, but should be cited)",
}

_WORD = re.compile(r"\w+", re.UNICODE)


class ExplainUnavailable(RuntimeError):
    """Neither provider could produce an explanation."""


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


def answer_language(match: dict) -> str:
    """Explain in the language the student wrote in (Vietnamese-first)."""
    return "Vietnamese" if _looks_vietnamese(match.get("input_sentence") or "") else "English"


def _quote(phrase: str, limit: int = 110) -> str:
    phrase = " ".join(phrase.split())
    return phrase if len(phrase) <= limit else phrase[: limit - 1].rstrip() + "…"


_TEXT = {
    "English": {
        "identical": (
            "This sentence is identical to the source{title}: every word matches, so it reads as copied word for word. "
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
            "Câu này giống hệt nguồn{title}: từng từ đều trùng, nên đọc lên như sao chép nguyên văn. "
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


def facts_explanation(match: dict, facts: dict | None = None) -> str:
    """Deterministic, always-correct explanation built only from the facts."""
    facts = facts or compute_facts(match)
    lang = answer_language(match)
    t = _TEXT[lang]
    # Web-page titles scraped from search results can be a paragraph of breadcrumbs.
    title_raw = _quote((match.get("source_title") or "").strip(), 80)
    title = t["title"].format(title=title_raw) if title_raw else ""

    shared, phrase = facts["shared_words"], _quote(facts["shared_phrase"])
    fields = dict(
        title=title, shared=shared, total=facts["student_words"], phrase=phrase, semantic=facts["semantic_pct"]
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
    suffix = t["definition"] if label == "common_academic_definition" else t["likely"] if label == "likely_plagiarism" else t["suspicious"] if label == "suspicious" else ""
    return (body.format(**fields) + suffix).strip()


# ---------------------------------------------------------------------------
# LLM polish: prompt, validation (pure)
# ---------------------------------------------------------------------------

def _clip(text: str, limit: int = 700) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def build_prompt(match: dict, facts: dict | None = None) -> str:
    facts = facts or compute_facts(match)
    label = match.get("label") or ""
    title = (match.get("source_title") or "").strip() or "an unnamed source"

    if facts["identical"]:
        shared_line = "The two passages are IDENTICAL, word for word."
    elif facts["shared_words"] >= PHRASE_MIN_WORDS:
        shared_line = (
            f"The longest run of words they share is {facts['shared_words']} words: \"{_quote(facts['shared_phrase'])}\" "
            f"(covering {round(facts['coverage'] * 100)}% of the student's sentence)."
        )
    else:
        shared_line = (
            f"They share no run of {PHRASE_MIN_WORDS} or more identical words; the overlap is in meaning and structure, "
            "not in copied wording."
        )

    return f"""
A passage from a student's document was flagged as similar to a published source.

VERIFIED FACTS (ground truth; never contradict them, and do not quote anything that is not in the two passages):
- {shared_line}
- Meaning similarity: {facts['semantic_pct']}%. Shared words overall: {facts['overlap_pct']}%. The match is {_LABEL_HINTS.get(label, "classified as a possible match")}.
- Source: {title}

STUDENT TEXT:
\"\"\"{_clip(match.get("input_sentence"))}\"\"\"

SOURCE TEXT:
\"\"\"{_clip(match.get("source_sentence"))}\"\"\"

Write 2 or 3 short sentences (under 70 words in total) that:
1. say what the passages share, consistent with the verified facts above;
2. say how much this should worry the student, consistent with the classification; do not exaggerate;
3. give one concrete fix, such as quoting and citing the source, or restating the idea in the student's own structure.

Write the answer in {answer_language(match)}. Plain text only.
""".strip()


_QUOTED = re.compile(r"[\"“”«»]([^\"“”«»]{3,})[\"“”«»]")
_CLAIMS_VERBATIM = re.compile(
    r"verbatim|word[- ]for[- ]word|copied exactly|exact(ly)? (the same|copy)|identical|giống hệt|nguyên văn|sao chép nguyên",
    re.IGNORECASE,
)
_CLAIMS_DIFFERENT = re.compile(
    r"differ|different|rephras|reworded|paraphras|khác|diễn đạt lại|viết lại",
    re.IGNORECASE,
)


def _normalized(text: str) -> str:
    return " ".join(w for w, _, _ in _words(text))


def validate_llm_text(text: str, match: dict, facts: dict) -> str | None:
    """Reason the LLM's answer must be rejected, or None if it is acceptable."""
    if not text:
        return "empty"
    haystack = _normalized(match.get("input_sentence") or "") + " || " + _normalized(match.get("source_sentence") or "")
    for quoted in _QUOTED.findall(text):
        if _normalized(quoted) and _normalized(quoted) not in haystack:
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

def explain_with_gemini(match: dict, facts: dict | None = None) -> str:
    import google.generativeai as genai

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise ExplainUnavailable("GEMINI_API_KEY is not set.")
    genai.configure(api_key=api_key)
    model = genai.GenerativeModel(GEMINI_EXPLAIN_MODEL, system_instruction=SYSTEM_PROMPT)
    response = model.generate_content(
        build_prompt(match, facts),
        generation_config={"temperature": 0.2, "max_output_tokens": 220},
    )
    return clean_explanation(getattr(response, "text", "") or "")


def explain_with_local_model(match: dict, facts: dict | None = None) -> str:
    import llm_metadata

    llm_metadata._ensure_local_model_loaded()
    tokenizer, model = llm_metadata._tokenizer, llm_metadata._model
    if tokenizer is None or model is None:
        raise ExplainUnavailable("Local model failed to load.")

    import torch

    prompt = tokenizer.apply_chat_template(
        [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": build_prompt(match, facts)}],
        tokenize=False,
        add_generation_prompt=True,
    )
    inputs = tokenizer(prompt, return_tensors="pt", truncation=True, max_length=2048).to(model.device)
    with torch.no_grad():
        outputs = model.generate(
            **inputs,
            max_new_tokens=LOCAL_EXPLAIN_MAX_NEW_TOKENS,
            do_sample=False,
            temperature=None,
            top_p=None,
            top_k=None,
            pad_token_id=tokenizer.eos_token_id,
        )
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
                failures[name] = 0
                upgraded += 1
                break
            except Exception as exc:  # noqa: BLE001 — try the next provider, else keep the fact-based text
                failures[name] += 1
                logger.warning("AI explanation via %s failed: %s", name, exc)

    return {"upgraded": upgraded, "total": len(matches), "attempted_limit": limit}
