"""
gemini_client.py
----------------
Small, thread-safe HTTP client for the Gemini REST API. Each call carries its
own `x-goog-api-key` header and timeout so concurrent tasks can use separate
credentials without global SDK state races.
"""

from __future__ import annotations

from typing import Any, Optional

import httpx

GEMINI_GENERATE_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


class GeminiRequestError(RuntimeError):
    """Raised when a Gemini REST call fails or returns an unusable payload."""

    def __init__(self, message: str, *, status_code: Optional[int] = None) -> None:
        super().__init__(message)
        self.status_code = status_code


def extract_gemini_text(payload: dict[str, Any]) -> str:
    """Extract joined text parts from the first candidate of a Gemini response."""
    if not isinstance(payload, dict):
        return ""
    candidates = payload.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        return ""
    first = candidates[0] if isinstance(candidates[0], dict) else {}
    content = first.get("content") if isinstance(first.get("content"), dict) else {}
    parts = content.get("parts") if isinstance(content.get("parts"), list) else []
    texts = [str(p.get("text") or "") for p in parts if isinstance(p, dict) and p.get("text")]
    return " ".join(texts).strip()


def generate_content(
    *,
    api_key: str,
    model: str,
    prompt: str,
    system_instruction: Optional[str] = None,
    generation_config: Optional[dict[str, Any]] = None,
    timeout: float = 20.0,
    http_client: Any = None,
) -> str:
    """Call Gemini `generateContent` with per-request credentials and timeout."""
    resolved_key = (api_key or "").strip()
    if not resolved_key:
        raise GeminiRequestError("Gemini API key is not set.")

    resolved_model = (model or "gemini-flash-latest").strip()
    url = GEMINI_GENERATE_URL.format(model=resolved_model)
    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": resolved_key,
    }
    body: dict[str, Any] = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
    }
    if system_instruction:
        body["systemInstruction"] = {"parts": [{"text": system_instruction}]}
    if generation_config:
        body["generationConfig"] = dict(generation_config)

    caller = http_client.post if http_client is not None else httpx.post
    try:
        resp = caller(url, headers=headers, json=body, timeout=float(timeout))
    except Exception as exc:  # noqa: BLE001
        raise GeminiRequestError(f"Gemini HTTP request failed: {exc}") from exc

    status_code = getattr(resp, "status_code", 500)
    if status_code >= 400:
        raise GeminiRequestError(f"Gemini HTTP {status_code}", status_code=status_code)

    try:
        payload = resp.json()
    except Exception as exc:  # noqa: BLE001
        raise GeminiRequestError("Invalid JSON from Gemini endpoint.") from exc

    text = extract_gemini_text(payload)
    if not text:
        raise GeminiRequestError("Gemini returned an empty response.")
    return text
