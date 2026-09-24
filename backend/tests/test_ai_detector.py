"""
Tests for ai_detector: the pure parts (segment selection, scoring, summary,
reasons) and the never-raises contract of detect_ai_content. The reference LM
is replaced by an injected extractor, so none of this needs a GPU or weights.
"""

import math

import ai_detector
from ai_detector import (
    DetectorUnavailable,
    build_reasons,
    detect_ai_content,
    guess_language,
    level_for,
    normalize_text,
    score_from_features,
    select_segments,
    summarize,
)

LONG = " ".join(["word"] * 60)  # 60 words, above MIN_WORDS_PER_SEGMENT


def _doc(text_blocks):
    """Build a (document, input_text) pair from [(type, text), ...]."""
    text, blocks, cursor = "", [], 0
    for i, (kind, body) in enumerate(text_blocks):
        start = cursor
        text += body
        cursor = len(text)
        blocks.append({"block_id": f"b{i}", "type": kind, "start": start, "end": cursor})
        text += "\n\n"
        cursor = len(text)
    return {"blocks": blocks}, text


class TestNormalize:
    def test_folds_pdf_ligatures_and_line_break_hyphens(self):
        assert normalize_text("speciﬁc detec- tion\nof   text") == "specific detection of text"

    def test_keeps_real_hyphenated_words(self):
        assert normalize_text("state-of-the-art model") == "state-of-the-art model"


class TestLanguage:
    def test_english_vietnamese_other(self):
        assert guess_language("The quick brown fox jumps over the lazy dog.") == "en"
        assert guess_language("Mô hình này xử lý ngôn ngữ tự nhiên rất tốt.") == "vi"
        assert guess_language("Это русский текст без латиницы") == "other"


class TestSelectSegments:
    def test_only_long_paragraphs_are_analysed(self):
        document, text = _doc([("heading", "Intro"), ("paragraph", LONG), ("paragraph", "too short"), ("table", LONG)])
        segments = select_segments(document, text)
        assert [s["block_id"] for s in segments] == ["b1"]
        assert segments[0]["words"] == 60

    def test_offsets_index_into_the_original_text(self):
        document, text = _doc([("paragraph", LONG), ("paragraph", LONG)])
        for seg in select_segments(document, text):
            assert text[seg["start"]:seg["end"]].split() == seg["text"].split()

    def test_unstructured_text_splits_on_blank_lines(self):
        text = LONG + "\n\n" + LONG
        assert len(select_segments(None, text)) == 2

    def test_long_documents_are_sampled_evenly_and_bounded(self):
        document, text = _doc([("paragraph", LONG)] * (ai_detector.MAX_SEGMENTS * 3))
        segments = select_segments(document, text)
        assert len(segments) == ai_detector.MAX_SEGMENTS
        # spread across the whole document, not just the first pages
        assert segments[-1]["start"] > len(text) / 2


class TestScoring:
    W = {"bias": 8.0, "mean_nll": -3.0, "top1_frac": 6.0, "sent_std": -1.0}

    def test_more_predictable_text_scores_higher(self):
        predictable = {"mean_nll": 1.8, "top1_frac": 0.6, "sent_std": 0.4}
        surprising = {"mean_nll": 3.8, "top1_frac": 0.3, "sent_std": 1.2}
        assert score_from_features(predictable, self.W) > 0.9
        assert score_from_features(surprising, self.W) < 0.1

    def test_score_is_a_probability_even_for_extreme_inputs(self):
        for nll in (-1e6, 0, 1e6):
            p = score_from_features({"mean_nll": nll, "top1_frac": 0.5, "sent_std": 0.5}, self.W)
            assert 0.0 <= p <= 1.0

    def test_levels(self):
        assert level_for(10) == "low"
        assert level_for(45) == "possible"
        assert level_for(80) == "likely"


class TestSummarize:
    def _seg(self, prob, words=100, **feat):
        f = {"mean_nll": 2.0, "top1_frac": 0.55, "sent_std": 0.4, **feat}
        return {"start": 0, "end": words, "block_id": "b", "words": words, "features": f, "probability": prob}

    def test_overall_is_word_weighted(self):
        result = summarize([self._seg(1.0, 300), self._seg(0.0, 100)], language="en", model_name="m")
        assert result["overall_score"] == 75.0
        assert result["ai_share"] == 75.0
        assert result["level"] == "likely"
        assert result["analyzed_words"] == 400
        assert result["confidence"] == "normal"

    def test_non_english_or_short_text_is_low_confidence(self):
        assert summarize([self._seg(0.5)], language="vi", model_name="m")["confidence"] == "low"
        assert summarize([self._seg(0.5, words=50)], language="en", model_name="m")["confidence"] == "low"

    def test_low_confidence_text_is_never_labelled_likely(self):
        strong = summarize([self._seg(1.0, 300)], language="vi", model_name="m")
        assert strong["overall_score"] == 100.0 and strong["level"] == "possible"
        assert summarize([self._seg(1.0, 300)], language="en", model_name="m")["level"] == "likely"

    def test_no_segments_is_a_clear_empty_result_not_a_crash(self):
        result = summarize([], language="en", model_name="m")
        assert result["available"] is True and result["overall_score"] == 0 and result["segments"] == []

    def test_reasons_come_from_the_numbers(self):
        flat = build_reasons({"mean_nll": 2.0, "top1_frac": 0.6, "sent_std": 0.3}, 90, 100, "en")
        human = build_reasons({"mean_nll": 3.8, "top1_frac": 0.3, "sent_std": 1.2}, 5, 0, "en")
        assert any("predictable" in r for r in flat) and any(str(round(math.exp(2.0))) in r for r in flat)
        assert any("unpredictable" in r for r in human)
        assert "calibrated on English" in " ".join(build_reasons({"mean_nll": 3, "top1_frac": 0.4, "sent_std": 1}, 0, 0, "vi"))


class TestDetectAiContent:
    def test_end_to_end_with_a_stub_extractor(self, monkeypatch):
        monkeypatch.setattr(ai_detector, "WEIGHTS", {"bias": 8.0, "mean_nll": -3.0, "top1_frac": 6.0, "sent_std": -1.0})
        document, text = _doc([("paragraph", LONG), ("paragraph", LONG)])
        result = detect_ai_content(
            document, text, extractor=lambda _t: {"mean_nll": 1.8, "top1_frac": 0.6, "sent_std": 0.4, "tokens": 80}
        )
        assert result["available"] and result["level"] == "likely"
        assert len(result["segments"]) == 2

    def test_missing_burstiness_is_neutral_not_a_crash(self):
        document, text = _doc([("paragraph", LONG)])
        result = detect_ai_content(
            document, text, extractor=lambda _t: {"mean_nll": 3.0, "top1_frac": 0.4, "sent_std": None, "tokens": 80}
        )
        assert result["available"] is True

    def test_unusable_model_reports_unavailable_instead_of_raising(self):
        document, text = _doc([("paragraph", LONG)])

        def boom(_t):
            raise DetectorUnavailable("no GPU")

        result = detect_ai_content(document, text, extractor=boom)
        assert result == {"available": False, "method": ai_detector.METHOD, "reason": "no GPU"}

    def test_any_unexpected_error_is_contained(self):
        document, text = _doc([("paragraph", LONG)])

        def boom(_t):
            raise ValueError("bad tensor")

        assert detect_ai_content(document, text, extractor=boom)["available"] is False
