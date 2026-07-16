import json
import re
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig
from config import LLM_MODEL_NAME


# =========================
# Load local LLM
# =========================

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
# LLM generation helper
# =========================

def generate_json_from_prompt(prompt, max_new_tokens=256, max_length=4096):
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

    input_text = tokenizer.apply_chat_template(
        messages,
        tokenize=False,
        add_generation_prompt=True
    )

    inputs = tokenizer(
        input_text,
        return_tensors="pt",
        truncation=True,
        max_length=max_length
    ).to(model.device)

    with torch.no_grad():
        outputs = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            pad_token_id=tokenizer.eos_token_id
        )

    generated_tokens = outputs[0][inputs["input_ids"].shape[-1]:]

    decoded = tokenizer.decode(
        generated_tokens,
        skip_special_tokens=True
    ).strip()

    return decoded


# =========================
# Metadata extraction: one paper
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
# Metadata extraction: section-by-section
# =========================

def extract_section_metadata_with_llm(section_name, section_text):
    """
    Extract metadata for ONE section.
    This is more stable than asking a small LLM to return 5 nested JSONs.
    Recommended for Qwen2.5-1.5B-Instruct.
    """
    if not section_text or len(section_text.strip()) < 50:
        return normalize_metadata({})

    prompt = f"""
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
    Recommended function.
    Calls LLM once per section, producing reliable JSON for each section.
    Slower than one-call, but much more stable for small local LLMs.
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
# Optional: faster but less stable one-call version
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
