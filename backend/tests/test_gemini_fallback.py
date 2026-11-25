"""Tests for per-task Gemini API key isolation and unreachable-API fallbacks."""
from __future__ import annotations

import httpx
import pytest

import ai_explain
import ai_rewrite
import gemini_client
import llm_metadata


def _clear_all_gemini_keys(monkeypatch) -> None:
    for var in (
        "GEMINI_API_KEY",
        "GEMINI_EXTRACTION_API_KEY",
        "GEMINI_REWRITE_API_KEY",
        "GEMINI_EXPLAIN_API_KEY",
    ):
        monkeypatch.delenv(var, raising=False)


class _FakeResp:
    def __init__(self, status_code: int, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


def test_gemini_client_raises_on_unreachable_timeout_http_error_and_empty():
    with pytest.raises(gemini_client.GeminiRequestError, match="not set"):
        gemini_client.generate_content(api_key="", model="gemini-flash-latest", prompt="hi")

    class _ConnectFail:
        def post(self, *a, **k):
            raise httpx.ConnectError("DNS resolution failed")

    with pytest.raises(gemini_client.GeminiRequestError, match="HTTP request failed"):
        gemini_client.generate_content(
            api_key="k", model="m", prompt="p", http_client=_ConnectFail()
        )

    class _TimeoutFail:
        def post(self, *a, **k):
            raise httpx.ReadTimeout("timed out")

    with pytest.raises(gemini_client.GeminiRequestError, match="HTTP request failed"):
        gemini_client.generate_content(
            api_key="k", model="m", prompt="p", http_client=_TimeoutFail()
        )

    for code in (401, 429, 503):
        class _StatusFail:
            def __init__(self, c: int):
                self._c = c

            def post(self, *a, **k):
                return _FakeResp(self._c, {})

        with pytest.raises(gemini_client.GeminiRequestError) as exc_info:
            gemini_client.generate_content(
                api_key="k", model="m", prompt="p", http_client=_StatusFail(code)
            )
        assert exc_info.value.status_code == code

    class _BadJson:
        def post(self, *a, **k):
            return _FakeResp(200, ValueError("not json"))

    with pytest.raises(gemini_client.GeminiRequestError, match="Invalid JSON"):
        gemini_client.generate_content(api_key="k", model="m", prompt="p", http_client=_BadJson())

    class _EmptyCandidates:
        def post(self, *a, **k):
            return _FakeResp(200, {"candidates": []})

    with pytest.raises(gemini_client.GeminiRequestError, match="empty response"):
        gemini_client.generate_content(
            api_key="k", model="m", prompt="p", http_client=_EmptyCandidates()
        )


def test_metadata_extraction_uses_only_extraction_key(monkeypatch):
    _clear_all_gemini_keys(monkeypatch)
    monkeypatch.setenv("GEMINI_API_KEY", "legacy-global")
    monkeypatch.setenv("GEMINI_REWRITE_API_KEY", "rewrite-key")
    monkeypatch.setenv("GEMINI_EXPLAIN_API_KEY", "explain-key")

    long_text = "This study investigates automated hate speech detection in Vietnamese text using transformer models. " * 2

    # Unset GEMINI_EXTRACTION_API_KEY -> ignores other keys and goes straight to local model
    http_calls = []
    monkeypatch.setattr(llm_metadata.httpx, "post", lambda *a, **k: http_calls.append(1))
    monkeypatch.setattr(
        llm_metadata,
        "extract_section_metadata_with_llm",
        lambda name, text: llm_metadata.normalize_metadata({"task": "local-task", "field": "NLP"}),
    )
    res_no_key = llm_metadata.extract_all_section_metadata_gemini({"introduction": long_text})
    assert http_calls == []
    assert res_no_key["introduction"]["task"] == "local-task"

    # With GEMINI_EXTRACTION_API_KEY set -> sends only that key
    monkeypatch.setenv("GEMINI_EXTRACTION_API_KEY", "extraction-key")
    captured_headers = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured_headers.update(headers or {})
        return _FakeResp(
            200,
            {
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {"text": '```json\n{"field":"NLP","task":"hate speech detection","keywords":["ViHateT5"]}\n```'}
                            ]
                        }
                    }
                ]
            },
        )

    monkeypatch.setattr(llm_metadata.httpx, "post", fake_post)
    res = llm_metadata.extract_section_metadata_with_gemini("introduction", long_text)
    assert captured_headers["x-goog-api-key"] == "extraction-key"
    assert res["task"] == "hate speech detection"
    assert res["keywords"] == ["ViHateT5"]


@pytest.mark.parametrize(
    "exc_factory",
    [
        lambda: httpx.ConnectError("API unreachable"),
        lambda: httpx.ReadTimeout("timed out"),
    ],
)
def test_metadata_extraction_falls_back_to_local_when_gemini_unreachable(monkeypatch, exc_factory):
    _clear_all_gemini_keys(monkeypatch)
    monkeypatch.setenv("GEMINI_EXTRACTION_API_KEY", "extraction-key")

    def fail_post(*a, **k):
        raise exc_factory()

    monkeypatch.setattr(llm_metadata.httpx, "post", fail_post)
    monkeypatch.setattr(
        llm_metadata,
        "extract_section_metadata_with_llm",
        lambda name, text: llm_metadata.normalize_metadata({"task": f"local-{name}"}),
    )

    long_text = "Detailed experimental evaluation on benchmark datasets with multiple baselines and ablation runs. " * 2
    res = llm_metadata.extract_section_metadata_with_gemini("experiment", long_text)
    assert res["task"] == "local-experiment"


def test_metadata_extraction_all_sections_circuit_breaks_to_local(monkeypatch):
    _clear_all_gemini_keys(monkeypatch)
    monkeypatch.setenv("GEMINI_EXTRACTION_API_KEY", "extraction-key")

    gemini_attempts = []
    local_calls = []

    def fail_post(*a, **k):
        gemini_attempts.append(1)
        raise httpx.ConnectError("Gemini unreachable")

    monkeypatch.setattr(llm_metadata.httpx, "post", fail_post)
    monkeypatch.setattr(
        llm_metadata,
        "extract_section_metadata_with_llm",
        lambda name, text: (local_calls.append(name), llm_metadata.normalize_metadata({"task": f"local-{name}"}))[1],
    )

    long_text = "Transformer architectures achieve state of the art accuracy on multilingual benchmarks across domains. " * 2
    sections = {
        "title_abstract": long_text,
        "introduction": long_text,
        "related_work": long_text,
        "method": long_text,
        "experiment": long_text,
    }
    res = llm_metadata.extract_all_section_metadata_gemini(sections)

    assert len(gemini_attempts) == llm_metadata.MAX_CONSECUTIVE_GEMINI_FAILURES
    assert local_calls == ["title_abstract", "introduction", "related_work", "method", "experiment"]
    assert res["experiment"]["task"] == "local-experiment"

    # Immediate circuit break on 401/403 auth failure
    auth_attempts = []
    monkeypatch.setattr(
        llm_metadata.httpx,
        "post",
        lambda *a, **k: (auth_attempts.append(1), _FakeResp(401, {}))[1],
    )
    llm_metadata.extract_all_section_metadata_gemini(sections)
    assert len(auth_attempts) == 1

    # Even if local Qwen also fails, never raises — returns normalized empty schema
    monkeypatch.setattr(
        llm_metadata,
        "extract_section_metadata_with_llm",
        lambda name, text: (_ for _ in ()).throw(RuntimeError("GPU offline")),
    )
    safe = llm_metadata.extract_all_section_metadata_gemini({"introduction": long_text})
    assert safe["introduction"]["task"] == ""
    assert safe["introduction"]["keywords"] == []


def test_ai_rewrite_uses_only_rewrite_key_and_falls_back_to_local_when_unreachable(monkeypatch):
    _clear_all_gemini_keys(monkeypatch)
    monkeypatch.setattr(ai_rewrite, "is_gemini_ai_rewrite_enabled", lambda: True)

    user_text = "By harnessing a text-to-text architecture, the model tackles several tasks."
    source_text = "Using a unified text-to-text architecture, ViHateT5 handles multiple tasks."
    local_english = "Built around a unified framework, the system performs multiple tasks efficiently."

    # 1. Missing GEMINI_REWRITE_API_KEY (even with other keys set) -> falls back to local Qwen without HTTP call
    monkeypatch.setenv("GEMINI_API_KEY", "legacy-global")
    monkeypatch.setenv("GEMINI_EXTRACTION_API_KEY", "extraction-key")
    monkeypatch.setenv("GEMINI_EXPLAIN_API_KEY", "explain-key")
    http_calls = []
    monkeypatch.setattr(ai_rewrite.httpx, "post", lambda *a, **k: http_calls.append(1))
    monkeypatch.setattr(ai_rewrite, "rewrite_with_local_model", lambda *a, **k: local_english)

    res_no_key = ai_rewrite.rewrite_sentence(user_text, source_text)
    assert http_calls == []
    assert res_no_key["provider"] == "local"
    assert res_no_key["fallback_used"] is True
    assert res_no_key["rewritten_text"] == local_english

    # 2. GEMINI_REWRITE_API_KEY set, API unreachable -> falls back cleanly to local Qwen
    monkeypatch.setenv("GEMINI_REWRITE_API_KEY", "rewrite-key")
    seen_keys = []

    def fail_connect(url, headers=None, json=None, timeout=None):
        seen_keys.append((headers or {}).get("x-goog-api-key"))
        raise httpx.ConnectError("Gemini unreachable")

    monkeypatch.setattr(ai_rewrite.httpx, "post", fail_connect)
    res_unreachable = ai_rewrite.rewrite_sentence(user_text, source_text)
    assert seen_keys == ["rewrite-key"]
    assert res_unreachable["provider"] == "local"
    assert res_unreachable["fallback_used"] is True
    assert res_unreachable["rewritten_text"] == local_english

    # 3. GEMINI_REWRITE_API_KEY succeeds
    def ok_post(url, headers=None, json=None, timeout=None):
        assert (headers or {}).get("x-goog-api-key") == "rewrite-key"
        return _FakeResp(
            200,
            {"candidates": [{"content": {"parts": [{"text": "The architecture lets the model execute various tasks."}]}}]},
        )

    monkeypatch.setattr(ai_rewrite.httpx, "post", ok_post)
    res_ok = ai_rewrite.rewrite_sentence(user_text, source_text)
    assert res_ok["provider"] == "gemini"
    assert res_ok["fallback_used"] is False


def test_ai_explain_uses_only_explain_key_and_falls_back_when_unreachable(monkeypatch):
    _clear_all_gemini_keys(monkeypatch)
    monkeypatch.setenv("GEMINI_API_KEY", "legacy-global")
    monkeypatch.setenv("GEMINI_EXTRACTION_API_KEY", "extraction-key")
    monkeypatch.setenv("GEMINI_REWRITE_API_KEY", "rewrite-key")

    match = {
        "label": "likely_plagiarism",
        "input_sentence": "The model evaluates several academic benchmarks consistently.",
        "source_sentence": "The model evaluates several academic benchmarks consistently.",
        "source_title": "BenchPaper",
        "semantic_similarity": 0.99,
    }

    # On-demand explain without GEMINI_EXPLAIN_API_KEY -> facts fallback without HTTP call
    http_calls = []
    monkeypatch.setattr(ai_explain.httpx, "post", lambda *a, **k: http_calls.append(1))
    out_no_key = ai_explain.explain_single_match(match, language="en")
    assert http_calls == []
    assert out_no_key["source"] == "facts"

    # With GEMINI_EXPLAIN_API_KEY set, unreachable API -> facts fallback on-demand, local -> facts in batch
    monkeypatch.setenv("GEMINI_EXPLAIN_API_KEY", "explain-key")
    seen_keys = []

    def fail_post(url, headers=None, json=None, timeout=None):
        seen_keys.append((headers or {}).get("x-goog-api-key"))
        raise httpx.ConnectError("Gemini unreachable")

    monkeypatch.setattr(ai_explain.httpx, "post", fail_post)
    monkeypatch.setattr(ai_explain, "is_gemini_explanations_enabled", lambda: True)

    out_unreachable = ai_explain.explain_single_match(match, language="en")
    assert seen_keys == ["explain-key"]
    assert out_unreachable["source"] == "facts"

    def local_ok(_m, _f=None):
        return "This passage matches BenchPaper word for word; place it in quotes and cite it."

    monkeypatch.setattr(
        ai_explain,
        "PROVIDERS",
        {"gemini": ai_explain.explain_with_gemini, "local": local_ok},
    )
    batch_copy = [dict(match)]
    stats = ai_explain.explain_matches(batch_copy, use_llm=True)
    assert stats["upgraded"] == 1
    assert batch_copy[0]["explanation_source"] == "llm:local"
