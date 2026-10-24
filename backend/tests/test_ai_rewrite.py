"""
Tests for ai_rewrite: the English-only prompt, the language guard, and the
retry / provider-fallback flow around it.

Background: the rewrite prompt used to be written in Vietnamese, so models often
answered in Vietnamese even for English passages. The prompt is now English and
`rewrite_sentence` rejects (and retries) a reply that still comes back Vietnamese.
"""

import pytest

import ai_rewrite
from ai_rewrite import (
    RewriteUnavailable,
    _clean_output,
    _looks_vietnamese,
    build_rewrite_prompt,
    rewrite_sentence,
)

USER_TEXT = "By harnessing a text-to-text architecture, the model tackles several tasks."
SOURCE_TEXT = "Using a unified text-to-text architecture, ViHateT5 handles multiple tasks."
ENGLISH_REWRITE = "The model handles several tasks at once because it is built on a text-to-text design."
VIETNAMESE_REWRITE = "Mô hình xử lý nhiều tác vụ nhờ kiến trúc văn bản sang văn bản."


class TestPrompt:
    def test_contains_both_texts_and_the_key_rules(self):
        prompt = build_rewrite_prompt(USER_TEXT, SOURCE_TEXT)

        assert USER_TEXT in prompt
        assert SOURCE_TEXT in prompt
        assert "English only" in prompt  # language rule
        assert "four or more consecutive words" in prompt  # anti-plagiarism rule
        assert "Keep the meaning exactly the same" in prompt  # meaning-preservation rule

    def test_instructions_themselves_are_not_vietnamese(self):
        # The instructions being Vietnamese is what pulled answers into Vietnamese.
        instructions = build_rewrite_prompt("x", "y") + ai_rewrite.REWRITE_SYSTEM_PROMPT
        assert not _looks_vietnamese(instructions)

    def test_strict_adds_a_language_reminder(self):
        assert "not in English" not in build_rewrite_prompt(USER_TEXT, SOURCE_TEXT)
        assert "not in English" in build_rewrite_prompt(USER_TEXT, SOURCE_TEXT, strict=True)


class TestLooksVietnamese:
    def test_detects_vietnamese(self):
        assert _looks_vietnamese(VIETNAMESE_REWRITE)
        assert _looks_vietnamese("Phát hiện ngôn ngữ thù ghét trong tiếng Việt")

    def test_english_is_not_vietnamese(self):
        assert not _looks_vietnamese(ENGLISH_REWRITE)

    def test_a_loanword_accent_does_not_trip_it(self):
        assert not _looks_vietnamese("The café-style dataset was scraped from several public forums in 2023.")

    @pytest.mark.parametrize("text", ["", "   ", "12345 !!!"])
    def test_no_letters_is_not_vietnamese(self, text):
        assert not _looks_vietnamese(text)


class TestCleanOutput:
    def test_strips_quotes_fences_and_labels(self):
        assert _clean_output('"Hello world."') == "Hello world."
        assert _clean_output("```\nHello world.\n```") == "Hello world."
        assert _clean_output("Rewritten: Hello world.") == "Hello world."
        assert _clean_output("Here is the rewritten passage: Hello world.") == "Hello world."

    def test_strips_leading_pdf_bullets(self):
        assert _clean_output("• The model improves.") == "The model improves."
        assert _clean_output("▪  ● The model improves.") == "The model improves."

    def test_leaves_ordinary_text_alone(self):
        text = "Rewritten models often outperform baselines: see Table 2."
        # "Rewritten models ..." is not a label (no colon right after the label words).
        assert _clean_output(text) == text


@pytest.fixture
def gemini_first(monkeypatch):
    monkeypatch.setattr(ai_rewrite, "is_gemini_ai_rewrite_enabled", lambda: True)


class TestRewriteSentenceLanguageGuard:
    def test_retries_once_when_the_first_reply_is_vietnamese(self, monkeypatch, gemini_first):
        calls = []

        def fake_gemini(input_sentence, source_sentence, *, strict=False):
            calls.append(strict)
            return ENGLISH_REWRITE if strict else VIETNAMESE_REWRITE

        monkeypatch.setattr(ai_rewrite, "rewrite_with_gemini", fake_gemini)

        result = rewrite_sentence(USER_TEXT, SOURCE_TEXT)

        assert calls == [False, True]  # second attempt used the strict prompt
        assert result["rewritten_text"] == ENGLISH_REWRITE
        assert result["provider"] == "gemini"
        assert result["fallback_used"] is False

    def test_english_reply_is_accepted_without_a_retry(self, monkeypatch, gemini_first):
        calls = []

        def fake_gemini(input_sentence, source_sentence, *, strict=False):
            calls.append(strict)
            return ENGLISH_REWRITE

        monkeypatch.setattr(ai_rewrite, "rewrite_with_gemini", fake_gemini)

        assert rewrite_sentence(USER_TEXT, SOURCE_TEXT)["rewritten_text"] == ENGLISH_REWRITE
        assert calls == [False]

    def test_falls_back_to_the_other_provider_if_still_vietnamese(self, monkeypatch, gemini_first):
        monkeypatch.setattr(ai_rewrite, "rewrite_with_gemini", lambda *a, **k: VIETNAMESE_REWRITE)
        monkeypatch.setattr(ai_rewrite, "rewrite_with_local_model", lambda *a, **k: ENGLISH_REWRITE)

        result = rewrite_sentence(USER_TEXT, SOURCE_TEXT)

        assert result["provider"] == "local"
        assert result["fallback_used"] is True
        assert result["rewritten_text"] == ENGLISH_REWRITE

    def test_raises_when_no_provider_produces_english(self, monkeypatch, gemini_first):
        monkeypatch.setattr(ai_rewrite, "rewrite_with_gemini", lambda *a, **k: VIETNAMESE_REWRITE)
        monkeypatch.setattr(ai_rewrite, "rewrite_with_local_model", lambda *a, **k: VIETNAMESE_REWRITE)

        with pytest.raises(RewriteUnavailable):
            rewrite_sentence(USER_TEXT, SOURCE_TEXT)


def _verdict(text, weight=0.0):
    if not weight:
        return {"status": "clean", "hits": []}
    return {"status": "flagged", "hits": [{"input_sentence": text, "weight": weight, "source_sentence": SOURCE_TEXT}]}


class TestRewriteCheckedAgainstTheReport:
    def test_a_rewrite_that_still_overlaps_is_regenerated_with_feedback(self, monkeypatch, gemini_first):
        feedbacks = []

        def fake_gemini(input_sentence, source_sentence, *, strict=False, feedback=None):
            feedbacks.append(feedback)
            return "first try" if feedback is None else "second try"

        monkeypatch.setattr(ai_rewrite, "rewrite_with_gemini", fake_gemini)
        verdicts = {"first try": _verdict("first try", 1.0), "second try": _verdict("second try")}

        result = rewrite_sentence(USER_TEXT, SOURCE_TEXT, check=verdicts.__getitem__)

        assert result["rewritten_text"] == "second try"
        assert result["check"]["status"] == "clean"
        assert result["attempts"] == 2
        assert feedbacks[1] == {"previous": "first try", "overlaps": [SOURCE_TEXT]}

    def test_returns_the_least_overlapping_attempt_when_none_is_clean(self, monkeypatch, gemini_first):
        replies = iter(["heavy overlap", "light overlap", "heavy again"])
        monkeypatch.setattr(ai_rewrite, "rewrite_with_gemini", lambda *a, **k: next(replies))
        weights = {"heavy overlap": 1.0, "light overlap": 0.1, "heavy again": 1.0}

        result = rewrite_sentence(USER_TEXT, SOURCE_TEXT, check=lambda text: _verdict(text, weights[text]))

        assert result["rewritten_text"] == "light overlap"
        assert result["attempts"] == ai_rewrite.MAX_REWRITE_ATTEMPTS

    def test_a_failing_check_still_returns_the_rewrite(self, monkeypatch, gemini_first):
        monkeypatch.setattr(ai_rewrite, "rewrite_with_gemini", lambda *a, **k: ENGLISH_REWRITE)

        def broken_check(text):
            raise RuntimeError("no corpus")

        result = rewrite_sentence(USER_TEXT, SOURCE_TEXT, check=broken_check)
        assert result["rewritten_text"] == ENGLISH_REWRITE
        assert "check" not in result

    def test_feedback_names_the_overlapping_sentences_in_the_prompt(self):
        prompt = ai_rewrite.build_rewrite_prompt(
            USER_TEXT, SOURCE_TEXT, feedback={"previous": "my old try", "overlaps": ["the copied sentence"]}
        )
        assert "my old try" in prompt and '"the copied sentence"' in prompt
