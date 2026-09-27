"""
Tests for ai_explain: the fact computation, the always-correct fact-based
explanation, validation that rejects a hallucinating LLM, prompt content, and
provider fallback. Providers are injected; no model or network is used.
"""

import ai_explain
from ai_explain import (
    build_prompt,
    clean_explanation,
    compute_facts,
    explain_matches,
    facts_explanation,
    select_for_llm,
    validate_llm_text,
)

STUDENT = "Also, note that this second process is applied to the ground truth data in order to compute the metrics."


def _match(i=0, **over):
    base = {
        "label": "likely_plagiarism",
        "input_sentence": f"The model handles many tasks at once, number {i}.",
        "source_sentence": f"Many tasks are handled simultaneously by the model, number {i}.",
        "source_title": "ViHateT5",
        "semantic_similarity": 0.83,
        "word_overlap": 0.4,
        "char_ngram_overlap": 0.35,
        "explanation": "TEMPLATE",
    }
    base.update(over)
    return base


class TestFacts:
    def test_identical_text_is_detected_regardless_of_case_and_punctuation(self):
        facts = compute_facts(_match(input_sentence="Hello, World of data!", source_sentence="hello world of data"))
        assert facts["identical"] and facts["whole_sentence"]

    def test_longest_shared_run_is_quoted_in_the_students_casing(self):
        facts = compute_facts(
            _match(
                input_sentence="We then apply This Second Process to all the ground truth data before scoring.",
                source_sentence="Note that this second process to all the ground truth data is repeated.",
            )
        )
        assert facts["shared_words"] == 9
        assert facts["shared_phrase"].lower() == "this second process to all the ground truth data"
        assert not facts["identical"]

    def test_reworded_text_shares_no_long_run(self):
        facts = compute_facts(_match())
        assert facts["shared_words"] < ai_explain.PHRASE_MIN_WORDS
        assert not facts["identical"]

    def test_empty_sides_do_not_crash(self):
        facts = compute_facts(_match(input_sentence="", source_sentence=""))
        assert facts["shared_words"] == 0 and not facts["identical"]


class TestFactsExplanation:
    def test_identical_is_called_identical_never_different(self):
        m = _match(input_sentence=STUDENT, source_sentence=STUDENT)
        text = facts_explanation(m)
        assert "identical" in text and "differ" not in text.lower()
        assert "ViHateT5" in text

    def test_long_shared_run_quotes_the_exact_phrase_and_count(self):
        m = _match(
            input_sentence="We then apply this second process to all the ground truth data before scoring today.",
            source_sentence="Note that this second process to all the ground truth data is repeated.",
        )
        text = facts_explanation(m)
        assert "this second process to all the ground truth data" in text
        assert "9-word" in text

    def test_reworded_text_is_not_accused_of_verbatim_copying(self):
        text = facts_explanation(_match()).lower()
        assert "word for word" not in text and "verbatim" not in text
        assert "83%" in text

    def test_common_definition_is_reassuring_but_asks_for_a_citation(self):
        text = facts_explanation(_match(label="common_academic_definition")).lower()
        assert "standard definition" in text and "cite" in text

    def test_answers_in_vietnamese_when_the_student_wrote_vietnamese(self):
        vi = "Trí tuệ nhân tạo giúp cá nhân hóa quá trình học tập của từng sinh viên rất hiệu quả."
        text = facts_explanation(_match(input_sentence=vi, source_sentence=vi))
        assert "giống hệt" in text

    def test_a_scraped_page_title_full_of_breadcrumbs_is_shortened(self):
        long_title = "ViHateT5: Enhancing Hate Speech Detection " + "| Some Website Breadcrumb " * 12
        text = facts_explanation(_match(input_sentence=STUDENT, source_sentence=STUDENT, source_title=long_title))
        assert len(text) < 700 and "…" in text

    def test_definition_without_a_shared_run_is_only_reassurance(self):
        text = facts_explanation(_match(label="common_academic_definition")).lower()
        assert "standard definition" in text and "restructure" not in text

    def test_deterministic(self):
        m = _match()
        assert facts_explanation(m) == facts_explanation(dict(m))


class TestValidation:
    def _facts(self, m):
        return compute_facts(m)

    def test_rejects_a_quote_that_is_in_neither_passage(self):
        m = _match()
        assert validate_llm_text('They share "exact phrase here" verbatim.', m, self._facts(m))

    def test_accepts_a_quote_taken_from_the_passages(self):
        m = _match()
        assert validate_llm_text('Both mention "many tasks" in a similar way.', m, self._facts(m)) is None

    def test_rejects_calling_identical_text_different(self):
        m = _match(input_sentence=STUDENT, source_sentence=STUDENT)
        assert validate_llm_text("The two passages differ slightly in wording.", m, self._facts(m))

    def test_rejects_claiming_verbatim_copy_without_evidence(self):
        m = _match()
        assert validate_llm_text("This was lifted verbatim from the source.", m, self._facts(m))

    def test_accepts_a_faithful_answer_and_rejects_empty(self):
        m = _match()
        assert validate_llm_text("The meaning matches the source but the wording is different; cite it.", m, self._facts(m)) is None
        assert validate_llm_text("", m, self._facts(m))


class TestPrompt:
    def test_contains_texts_verified_facts_and_guidance(self):
        m = _match(input_sentence=STUDENT, source_sentence=STUDENT)
        prompt = build_prompt(m)
        assert "IDENTICAL" in prompt and "VERIFIED FACTS" in prompt
        assert "concrete fix" in prompt

    def test_reworded_prompt_states_there_is_no_shared_run(self):
        assert "share no run of" in build_prompt(_match())

    def test_answers_in_the_students_language(self):
        assert "in English" in build_prompt(_match())
        vi = _match(input_sentence="Mô hình này xử lý nhiều tác vụ cùng một lúc rất hiệu quả.")
        assert "in Vietnamese" in build_prompt(vi)

    def test_instructions_are_english_so_answers_do_not_drift(self):
        assert not ai_explain._looks_vietnamese(ai_explain.SYSTEM_PROMPT + build_prompt(_match()))


class TestClean:
    def test_collapses_whitespace(self):
        assert "\n" not in clean_explanation("line one\n\nline two")

    def test_overlong_output_is_cut_at_a_sentence_boundary(self):
        text = ("This sentence is a reasonably long piece of explanatory text. " * 30).strip()
        out = clean_explanation(text)
        assert len(out) <= ai_explain.MAX_EXPLANATION_CHARS
        assert out.endswith(".")


class TestSelect:
    def test_takes_the_first_n_matches_that_have_both_texts(self):
        matches = [_match(0), _match(1, source_sentence=""), _match(2), _match(3)]
        assert [m["input_sentence"][-2] for m in select_for_llm(matches, 2)] == ["0", "2"]


def _ok(m, f=None):
    return "The wording differs but the meaning matches the source; restate it and cite."


class TestExplainMatches:
    def test_every_match_gets_a_fact_based_explanation_even_without_llm(self):
        matches = [_match(i) for i in range(3)]
        stats = explain_matches(matches, use_llm=False)
        assert all(m["explanation_source"] == "facts" and m["explanation"] != "TEMPLATE" for m in matches)
        assert stats["upgraded"] == 0

    def test_a_match_without_both_texts_keeps_its_existing_explanation(self):
        matches = [_match(source_sentence="")]
        explain_matches(matches, use_llm=False)
        assert matches[0]["explanation"] == "TEMPLATE" and matches[0]["explanation_source"] == "template"

    def test_upgrades_only_the_top_matches_and_records_the_source(self):
        matches = [_match(i) for i in range(5)]
        stats = explain_matches(matches, providers={"local": _ok}, order=["local"], limit=2)
        assert [m["explanation_source"] for m in matches] == ["llm:local", "llm:local", "facts", "facts", "facts"]
        assert stats["upgraded"] == 2

    def test_a_hallucinating_llm_is_discarded_and_the_facts_text_stays(self):
        matches = [_match(input_sentence=STUDENT, source_sentence=STUDENT)]
        explain_matches(matches, providers={"local": lambda m, f=None: "They differ slightly in wording."}, order=["local"])
        assert matches[0]["explanation_source"] == "facts"
        assert "identical" in matches[0]["explanation"]

    def test_falls_back_to_the_next_provider(self):
        def bad(_m, _f=None):
            raise ai_explain.ExplainUnavailable("down")

        matches = [_match()]
        explain_matches(matches, providers={"local": bad, "gemini": _ok}, order=["local", "gemini"])
        assert matches[0]["explanation_source"] == "llm:gemini"

    def test_when_every_provider_fails_the_facts_text_is_kept_and_nothing_raises(self):
        def bad(_m, _f=None):
            raise RuntimeError("boom")

        matches = [_match(0), _match(1)]
        stats = explain_matches(matches, providers={"local": bad}, order=["local"])
        assert all(m["explanation_source"] == "facts" for m in matches)
        assert stats["upgraded"] == 0

    def test_a_dead_provider_is_skipped_after_repeated_failures(self):
        calls = []

        def bad(_m, _f=None):
            calls.append(1)
            raise RuntimeError("boom")

        explain_matches([_match(i) for i in range(6)], providers={"local": bad}, order=["local"], limit=6)
        assert len(calls) == ai_explain.MAX_CONSECUTIVE_FAILURES

    def test_empty_output_keeps_the_facts_text(self):
        matches = [_match()]
        explain_matches(matches, providers={"local": lambda m, f=None: ""}, order=["local"])
        assert matches[0]["explanation_source"] == "facts"

    def test_time_budget_stops_further_llm_calls(self):
        ticks = iter([0.0, 0.0, 999.0, 999.0, 999.0])
        matches = [_match(i) for i in range(4)]
        explain_matches(
            matches,
            providers={"local": _ok},
            order=["local"],
            limit=4,
            time_budget=10,
            clock=lambda: next(ticks),
        )
        assert [m["explanation_source"] for m in matches] == ["llm:local", "facts", "facts", "facts"]


def test_fact_explanations_also_carry_their_facts_for_the_ui_language():
    identical = _match(input_sentence="The model is trained on social media comments.",
                       source_sentence="The model is trained on social media comments.")
    reworded = _match(1)
    explain_matches([identical, reworded], use_llm=False)
    assert identical["explanation_facts"]["kind"] == "identical"
    assert reworded["explanation_facts"]["kind"] == "reworded"
    assert reworded["explanation_facts"]["title"] == "ViHateT5"
    assert reworded["explanation_facts"]["semantic"] == 83


def test_an_llm_explanation_drops_the_facts_so_the_ui_shows_the_llm_text():
    matches = [_match(0), _match(1)]
    explain_matches(matches, providers={"local": _ok}, order=["local"], limit=1)
    assert "explanation_facts" not in matches[0]
    assert "explanation_facts" in matches[1]
