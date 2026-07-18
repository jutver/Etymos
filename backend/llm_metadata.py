import json
import logging
import os
import re
import threading
import time

import google.generativeai as genai

from config import LLM_MODEL_NAME
from supabase_client import get_client

logger = logging.getLogger(__name__)


# =========================
# Lazy local (Qwen) LLM load
# =========================
#
# NOTE: torch/transformers and the multi-GB Qwen weights are only loaded on
# the first call into a *local*-path function (extract_metadata_with_llm /
# extract_section_metadata_with_llm / extract_all_section_metadata /
# extract_all_section_metadata_one_call). Simply `import llm_metadata` no
# longer forces this load — important when the `gemini_metadata_extraction`
# feature flag is active and the local model is never used at all.

_local_model_lock = threading.Lock()
_tokenizer = None
_model = None


def _ensure_local_model_loaded():
    global _tokenizer, _model

    if _model is not None:
        return

    with _local_model_lock:
        if _model is not None:
            return

        import torch
        from transformers import (
            AutoModelForCausalLM,
            AutoTokenizer,
            BitsAndBytesConfig,
        )

        logger.info("Loading local LLM %s (lazy, first local-path use)...", LLM_MODEL_NAME)

        tokenizer = AutoTokenizer.from_pretrained(
            LLM_MODEL_NAME,
            trust_remote_code=True
        )

        bnb_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.float16,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True
        )

        model = AutoModelForCausalLM.from_pretrained(
            LLM_MODEL_NAME,
            quantization_config=bnb_config,
            device_map="auto",
            trust_remote_code=True,
            low_cpu_mem_usage=True
        )

        model.eval()

        _tokenizer = tokenizer
        _model = model


# =========================
# JSON helpers
# =========================

def extract_json(text):
    """
    Extract JSON object from model output.
    Handles:
    - ```json ... ```
    - raw JSON
    """
    code_block = re.search(
        r"```(?:json)?\s*(\{.*?\})\s*```",
        text,
        re.DOTALL
    )

    if code_block:
        text = code_block.group(1)

    start = text.find("{")
    end = text.rfind("}")

    if start == -1 or end == -1 or end <= start:
        print("\nLLM RAW OUTPUT:")
        print(text)
        return {}

    json_text = text[start:end + 1]

    try:
        return json.loads(json_text)
    except json.JSONDecodeError:
        print("\nJSON PARSE ERROR:")
        print(json_text)
        return {}


def ensure_list(value):
    if value is None or value == "":
        return []

    if isinstance(value, list):
        return [
            str(v).strip()
            for v in value
            if str(v).strip()
        ]

    return [str(value).strip()]


def normalize_metadata(metadata):
    """
    Normalize metadata into the same schema every time.
    """
    default_metadata = {
        "field": "",
        "task": "",
        "subtask": "",
        "problem": "",
        "method": [],
        "model": [],
        "dataset": [],
        "language": "",
        "domain": "",
        "keywords": []
    }

    if not isinstance(metadata, dict):
        return default_metadata

    normalized = default_metadata.copy()

    for key in normalized:
        if key in metadata:
            normalized[key] = metadata[key]

    normalized["method"] = ensure_list(normalized["method"])
    normalized["model"] = ensure_list(normalized["model"])
    normalized["dataset"] = ensure_list(normalized["dataset"])
    normalized["keywords"] = ensure_list(normalized["keywords"])

    for key in [
        "field",
        "task",
        "subtask",
        "problem",
        "language",
        "domain"
    ]:
        normalized[key] = str(normalized[key] or "").strip()

    return normalized


# =========================
# Local LLM generation helper
# =========================

def generate_json_from_prompt(prompt, max_new_tokens=256, max_length=4096):
    _ensure_local_model_loaded()

    messages = [
        {
            "role": "system",
            "content": "You extract academic metadata and return valid JSON only."
        },
        {
            "role": "user",
            "content": prompt
        }
    ]

    input_text = _tokenizer.apply_chat_template(
        messages,
        tokenize=False,
        add_generation_prompt=True
    )

    inputs = _tokenizer(
        input_text,
        return_tensors="pt",
        truncation=True,
        max_length=max_length
    ).to(_model.device)

    import torch

    with torch.no_grad():
        outputs = _model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            pad_token_id=_tokenizer.eos_token_id
        )

    generated_tokens = outputs[0][inputs["input_ids"].shape[-1]:]

    decoded = _tokenizer.decode(
        generated_tokens,
        skip_special_tokens=True
    ).strip()

    return decoded


# =========================
# Shared prompt builder (used by both the local and Gemini paths, so the
# extraction rules/schema stay in one place instead of drifting apart)
# =========================

def _build_section_metadata_prompt(section_name, section_text):
    return f"""
You are an academic paper section metadata extractor.

Return ONLY valid JSON. Do not add explanation.

Schema:
{{
  "field": "",
  "task": "",
  "subtask": "",
  "problem": "",
  "method": [],
  "model": [],
  "dataset": [],
  "language": "",
  "domain": "",
  "keywords": []
}}

Rules:
- Extract only information explicitly present in this section.
- Do not hallucinate.
- If information is missing, use "" or [].
- method, model, dataset, keywords must be lists.
- keywords should be concise academic search terms.
- If this section is Related Work, prefer extracting related research themes, models, methods, and datasets mentioned.
- If this section is Experiment, prioritize dataset names, metrics, baselines, and evaluation setting.
- If this section is Method, prioritize model architecture, algorithms, and pipeline components.
- If this section is Introduction, prioritize problem, task, language, domain, and motivation.

SECTION NAME:
{section_name}

SECTION TEXT:
{section_text[:1200]}
"""


# =========================
# Metadata extraction: one paper (local model)
# =========================

def extract_metadata_with_llm(title, abstract, introduction=""):
    """
    Extract one global metadata JSON for a paper.
    Use this when you only need one metadata object.
    """
    prompt = f"""
You are an academic paper metadata extractor.

Return ONLY valid JSON. Do not add explanation.

Schema:
{{
  "field": "",
  "task": "",
  "subtask": "",
  "problem": "",
  "method": [],
  "model": [],
  "dataset": [],
  "language": "",
  "domain": "",
  "keywords": []
}}

Definitions:
- field: broad academic field, e.g. NLP, Computer Vision, Healthcare AI, Data Mining, Recommendation Systems.
- task: general research task, e.g. Text Classification, Object Detection, Image Segmentation, Forecasting, Recommendation.
- subtask: the most specific task described in the paper.
- problem: the concrete problem the paper solves.
- method: main technical approaches. Return a list.
- model: model names only. Return a list.
- dataset: dataset names only. Return a list.
- language: target language if mentioned.
- domain: application domain.
- keywords: concise academic search terms useful for finding related papers.

Rules:
- Always return all keys in the schema.
- method, model, dataset, keywords must be lists.
- Do not hallucinate.
- If information is missing, use "" or [].
- Avoid generic words such as research, study, framework, system, approach as task.
- Prefer specific subtasks.
- The subtask must be more specific than task.
- Keep keywords short and academic.

Paper:

TITLE:
{title}

ABSTRACT:
{abstract[:2000]}

INTRODUCTION:
{introduction[:1200]}
"""

    decoded = generate_json_from_prompt(
        prompt,
        max_new_tokens=256,
        max_length=4096
    )

    print("\n===== LLM RAW OUTPUT =====")
    print(decoded)

    return normalize_metadata(extract_json(decoded))


# =========================
# Metadata extraction: section-by-section (local model)
# =========================

def extract_section_metadata_with_llm(section_name, section_text):
    """
    Extract metadata for ONE section.
    This is more stable than asking a small LLM to return 5 nested JSONs.
    Recommended for Qwen2.5-1.5B-Instruct.
    """
    if not section_text or len(section_text.strip()) < 50:
        return normalize_metadata({})

    prompt = _build_section_metadata_prompt(section_name, section_text)

    decoded = generate_json_from_prompt(
        prompt,
        max_new_tokens=256,
        max_length=3072
    )

    print(f"\n===== {section_name.upper()} METADATA RAW OUTPUT =====")
    print(decoded)

    return normalize_metadata(extract_json(decoded))


def extract_all_section_metadata(section_texts):
    """
    Recommended local-model function.
    Calls the local LLM once per section, producing reliable JSON for each
    section. Slower than one-call, but much more stable for small local LLMs.
    """
    section_metadata = {}

    target_sections = [
        "title_abstract",
        "introduction",
        "related_work",
        "method",
        "experiment"
    ]

    for section_name in target_sections:
        text = section_texts.get(section_name, "")

        print(f"\nExtracting metadata for section: {section_name}")
        metadata = extract_section_metadata_with_llm(
            section_name,
            text
        )

        section_metadata[section_name] = metadata

        print(f"\n===== {section_name.upper()} JSON METADATA =====")
        print(json.dumps(metadata, indent=2, ensure_ascii=False))

    return section_metadata


# =========================
# Optional: faster but less stable one-call version (local model)
# =========================

def extract_all_section_metadata_one_call(section_texts):
    """
    Faster, but less stable for small LLMs.
    Use only if speed is more important than JSON completeness.
    """
    schema_obj = {
        "field": "",
        "task": "",
        "subtask": "",
        "problem": "",
        "method": [],
        "model": [],
        "dataset": [],
        "language": "",
        "domain": "",
        "keywords": []
    }

    full_schema = {
        "title_abstract": schema_obj,
        "introduction": schema_obj,
        "related_work": schema_obj,
        "method": schema_obj,
        "experiment": schema_obj
    }

    prompt = f"""
You are an academic paper metadata extractor.

Return ONLY valid JSON. Do not add explanation.

You must return metadata for EVERY section below.
Do NOT skip any section.
Even if a section has little information, return the full schema with "" or [].

Required JSON schema:
{json.dumps(full_schema, ensure_ascii=False)}

Rules:
- Extract only information explicitly present in each section.
- Do not hallucinate.
- Missing information: use "" or [].
- method, model, dataset, keywords must be lists.
- Return ALL FIVE objects:
  title_abstract, introduction, related_work, method, experiment.

TITLE_ABSTRACT:
{section_texts.get("title_abstract", "")[:800]}

INTRODUCTION:
{section_texts.get("introduction", "")[:800]}

RELATED_WORK:
{section_texts.get("related_work", "")[:800]}

METHOD:
{section_texts.get("method", "")[:800]}

EXPERIMENT:
{section_texts.get("experiment", "")[:800]}
"""

    decoded = generate_json_from_prompt(
        prompt,
        max_new_tokens=1024,
        max_length=4096
    )

    print("\n===== ALL SECTION METADATA RAW OUTPUT =====")
    print(decoded)

    data = extract_json(decoded)

    result = {}

    for section in [
        "title_abstract",
        "introduction",
        "related_work",
        "method",
        "experiment"
    ]:
        result[section] = normalize_metadata(data.get(section, {}))

    return result


# =========================
# Metadata extraction: Gemini API path
# =========================
#
# Alongside the local Qwen path above, this uses the Gemini API for the
# same section-by-section metadata extraction, with the same output shape
# (a dict per section, normalized via normalize_metadata). Selected at
# call sites (backend/main.py, backend/doan_van.py) via the
# `gemini_metadata_extraction` feature flag — see
# is_gemini_metadata_extraction_enabled() below.

GEMINI_METADATA_MODEL = os.getenv("GEMINI_METADATA_MODEL", "gemini-flash-latest")
_genai_configured = False
_genai_configure_lock = threading.Lock()


def _ensure_genai_configured():
    global _genai_configured
    if _genai_configured:
        return
    with _genai_configure_lock:
        if _genai_configured:
            return
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "GEMINI_API_KEY is not set; cannot use Gemini metadata extraction."
            )
        genai.configure(api_key=api_key)
        _genai_configured = True


def extract_section_metadata_with_gemini(section_name, section_text):
    """
    Gemini-API equivalent of extract_section_metadata_with_llm: same
    schema, same rules, same normalized return shape — routed through the
    Gemini API instead of the local Qwen model.
    """
    if not section_text or len(section_text.strip()) < 50:
        return normalize_metadata({})

    prompt = _build_section_metadata_prompt(section_name, section_text)

    try:
        _ensure_genai_configured()
        gemini_model = genai.GenerativeModel(GEMINI_METADATA_MODEL)
        response = gemini_model.generate_content(prompt)
        decoded = (getattr(response, "text", None) or "").strip()
    except Exception:
        logger.exception(
            "Gemini metadata extraction failed for section=%s", section_name
        )
        return normalize_metadata({})

    print(f"\n===== {section_name.upper()} METADATA RAW OUTPUT (Gemini) =====")
    print(decoded)

    return normalize_metadata(extract_json(decoded))


def extract_all_section_metadata_gemini(section_texts):
    """
    Gemini-API equivalent of extract_all_section_metadata. Same output
    shape: a dict keyed by section name, each value a normalized metadata
    dict.
    """
    section_metadata = {}

    target_sections = [
        "title_abstract",
        "introduction",
        "related_work",
        "method",
        "experiment"
    ]

    for section_name in target_sections:
        text = section_texts.get(section_name, "")

        print(f"\nExtracting metadata for section (Gemini): {section_name}")
        metadata = extract_section_metadata_with_gemini(section_name, text)

        section_metadata[section_name] = metadata

        print(f"\n===== {section_name.upper()} JSON METADATA (Gemini) =====")
        print(json.dumps(metadata, indent=2, ensure_ascii=False))

    return section_metadata


# =========================
# Feature flag: gemini_metadata_extraction
# =========================

_FEATURE_FLAG_KEY = "gemini_metadata_extraction"
_FEATURE_FLAG_TTL_SECONDS = float(os.getenv("FEATURE_FLAG_CACHE_TTL_SECONDS", "45"))
_flag_cache: dict = {}
_flag_cache_lock = threading.Lock()


def is_gemini_metadata_extraction_enabled() -> bool:
    """
    Reads the `gemini_metadata_extraction` feature flag from Supabase
    (public.feature_flags, seeded by
    supabase/migrations/20260716120000_student_verification_and_audit_log.sql),
    with a short in-process cache (env FEATURE_FLAG_CACHE_TTL_SECONDS,
    default 45s) so we don't hit the DB on every extraction call.

    Falls back to False (i.e. use the local model) if the flag is
    missing, unreadable, or Supabase isn't configured in this
    environment — the VPS has a GPU, so local is the safe default per
    PLAN.md.
    """
    now = time.time()

    with _flag_cache_lock:
        cached = _flag_cache.get(_FEATURE_FLAG_KEY)
        if cached is not None and (now - cached[0]) < _FEATURE_FLAG_TTL_SECONDS:
            return cached[1]

    client = get_client()
    value = False

    if client is not None:
        try:
            resp = (
                client.table("feature_flags")
                .select("enabled")
                .eq("key", _FEATURE_FLAG_KEY)
                .maybe_single()
                .execute()
            )
            if resp and resp.data:
                value = bool(resp.data.get("enabled", False))
        except Exception:
            logger.exception(
                "Failed to read feature flag %s; falling back to local model.",
                _FEATURE_FLAG_KEY,
            )
            value = False

    with _flag_cache_lock:
        _flag_cache[_FEATURE_FLAG_KEY] = (now, value)

    return value


# =========================
# Query builder
# =========================

def to_text(value):
    if isinstance(value, list):
        return " ".join(str(v) for v in value if str(v).strip())

    return str(value or "").strip()


def clean_query(q, max_words=9):
    q = q.replace(",", " ")
    q = q.replace("(", " ")
    q = q.replace(")", " ")
    q = q.replace("[", " ")
    q = q.replace("]", " ")
    q = q.replace("'", " ")
    q = q.replace('"', " ")
    q = " ".join(q.split())
    words = q.split()

    return " ".join(words[:max_words])


def add_language_if_needed(language, text):
    if not language:
        return text

    if language.lower() in text.lower():
        return text

    return f"{language} {text}"


def build_queries_from_metadata(metadata):
    metadata = normalize_metadata(metadata)

    field = metadata["field"]
    task = metadata["task"]
    subtask = metadata["subtask"]
    model_name = to_text(metadata["model"])
    dataset = to_text(metadata["dataset"])
    language = metadata["language"]
    domain = metadata["domain"]
    keywords = metadata["keywords"]

    queries = []

    base_subtask = subtask or task
    lang_subtask = add_language_if_needed(language, base_subtask)

    candidates = [
        lang_subtask,
        f"{base_subtask} {dataset}",
        f"{base_subtask} {model_name}",
        f"{lang_subtask} {model_name}",
        f"{lang_subtask} {dataset}",
        f"{task} {base_subtask}",
        f"{domain} {base_subtask}",
        f"{field} {base_subtask}",
        " ".join(keywords[:4]),
    ]

    for q in candidates:
        q = clean_query(q)

        if len(q.split()) >= 2 and q not in queries:
            queries.append(q)

    if not queries:
        fallback = subtask or task or field or "scientific paper retrieval"
        queries.append(clean_query(fallback))

    return queries


def build_queries_from_section_metadata(section_metadata):
    """
    Build queries from multiple section metadata objects.
    Useful after extracting metadata for title_abstract, method, experiment, etc.
    """
    queries = []

    priority_sections = [
        "title_abstract",
        "method",
        "experiment",
        "introduction",
        "related_work"
    ]

    for section in priority_sections:
        metadata = section_metadata.get(section, {})
        section_queries = build_queries_from_metadata(metadata)

        for q in section_queries:
            if q not in queries:
                queries.append(q)

    return queries
