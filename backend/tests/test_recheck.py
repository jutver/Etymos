"""Save & re-check pipeline (backend/recheck.py) and POST /api/reports/{id}/recheck.
The search/download/match half is stubbed: these cover which blocks count as
changed, how matches move, the score parity, and charging."""
from __future__ import annotations

import threading

import pytest

import recheck
from final_report_builder import build_final_report

P1 = "The first paragraph explains the background of this study in some detail."
P2 = "Transformers learn contextual representations by attending over every token in the input."
P3 = "Our results show a clear improvement on all three benchmarks used here."


def blocks(*texts: str) -> list[dict]:
    return [{"block_id": f"b{i}", "text": t} for i, t in enumerate(texts)]


def passages(*texts: str) -> dict[str, dict]:
    return {f"b{i}": {"id": f"b{i}", "text": t, "block_type": "paragraph"} for i, t in enumerate(texts)}


def previous_report(texts: tuple[str, ...], sentence: str, label: str = "likely_plagiarism") -> dict:
    """A real build_final_report output with one match on `sentence`."""
    document, _ = recheck.build_edited_document(blocks(*texts), passages(*texts), [])
    start = document["text"].index(sentence)
    verified = [{
        "source_paper_id": "paper-1", "source_title": "Attention Is All You Need",
        "input_section": "input_text", "source_section": "abstract",
        "input_chunk_id": "c0", "source_chunk_id": "s0",
        "sentence_matches": [{
            "input_sentence_index": 0, "source_sentence_index": 0,
            "input_doc_start": start, "input_doc_end": start + len(sentence),
            "label": label, "input_sentence": sentence, "source_sentence": sentence,
            "semantic_similarity": 0.97, "word_overlap": 0.9, "char_ngram_overlap": 0.9,
        }],
    }]
    report = build_final_report(verified, [{"text": document["text"]}], input_text=document["text"], document=document)
    report["ai_detection"] = {"available": True, "overall_score": 12.0}
    return report


@pytest.fixture
def no_search(monkeypatch):
    calls = []

    def fake(document, runs, previous, progress_callback=None):
        calls.append([document["text"][s:e] for s, e in runs])
        return {"matches": [], "queries": [], "cited_sources": [],
                "coverage": {"total_candidate_papers": 0, "checked_papers": 0, "unavailable_papers": 0,
                             "status": "complete"}}

    monkeypatch.setattr(recheck, "match_changed_text", fake)
    no_enrichment(monkeypatch)
    return calls


def no_enrichment(monkeypatch):
    """AI detection loads a model: these tests keep the previous result."""
    import report_enrichment
    monkeypatch.setattr(report_enrichment, "enrich_report", lambda report, *a, **k: report)


# --- the edited document ------------------------------------------------------

def test_blocks_compare_with_their_stored_passage():
    doc, changed = recheck.build_edited_document(
        blocks(P1, P2 + " Extra words.", P3), passages(P1, P2, P3), [])
    assert changed == [False, True, False]
    assert doc["text"] == "\n\n".join([P1, P2 + " Extra words.", P3])
    assert [b["block_id"] for b in doc["blocks"]] == ["input_text_0", "input_text_1", "input_text_2"]


def test_without_passages_blocks_compare_by_text():
    doc, changed = recheck.build_edited_document(blocks(P3, "Brand new text here.", P1), {}, [P1, P2, P3])
    assert changed == [False, True, False]


def test_whitespace_differences_are_not_changes():
    _doc, changed = recheck.build_edited_document(blocks("  " + P1.replace(" ", "\n", 2)), passages(P1), [])
    assert changed == [False]


def test_highlight_numbers_from_old_editors_are_not_changes():
    # The old editor's innerText carried each highlight's <sup> number,
    # including one that landed mid-word when a highlight ended there.
    leaked = P1.replace("study", "study41").replace("some", "so62me")
    doc, changed = recheck.build_edited_document(blocks(leaked), passages(P1), [])
    assert changed == [False]
    assert doc["text"] == P1


def test_real_edits_next_to_numbers_still_count():
    _doc, changed = recheck.build_edited_document(
        blocks(P1.replace("study", "study1234"), P1.replace("background", "context")),
        passages(P1, P1), [])
    assert changed == [True, True]


def test_images_and_formatting_are_kept():
    stored = {
        "h": {"id": "h", "text": "Introduction", "block_type": "heading", "level": 2},
        "img": {"id": "img", "text": "", "block_type": "image", "image_url": "https://x/fig.png", "page": 3},
        "p": {"id": "p", "text": P1, "block_type": "paragraph", "text_marks": [{"start": 0, "end": 3, "bold": True}]},
    }
    doc, changed = recheck.build_edited_document(
        [{"block_id": "h", "text": "Introduction"}, {"block_id": "img", "text": ""}, {"block_id": "p", "text": P1 + " More."}],
        stored, [])
    heading, image, para = doc["blocks"]
    assert (heading["type"], heading["level"]) == ("heading", 2)
    assert (image["type"], image["image_url"], image["start"], image["end"]) == ("image", "https://x/fig.png", heading["end"], heading["end"])
    assert "marks" not in para  # text changed, so old bold ranges no longer apply
    assert changed == [False, True]


def test_changed_runs_merge_neighbours():
    doc, changed = recheck.build_edited_document(blocks("A1 new", "A2 new", P3, "B new"), passages(P1, P2, P3, "x"), [])
    runs = recheck.changed_runs(doc, changed)
    assert [doc["text"][s:e] for s, e in runs] == ["A1 new\n\nA2 new", "B new"]


# --- carrying matches -----------------------------------------------------------

def test_matches_move_when_an_earlier_block_grows():
    prev = previous_report((P1, P2, P3), P3)
    longer = P1 + " A whole new sentence was added to this first paragraph."
    doc, changed = recheck.build_edited_document(blocks(longer, P2, P3), passages(P1, P2, P3), [])
    carried = recheck.carry_over_matches(prev["matches"], doc, changed)
    assert len(carried) == 1
    offset = carried[0]["input_offset"]
    assert doc["text"][offset["start"]:offset["end"]] == P3
    assert offset["block_id"] == "input_text_2"


def test_matches_move_when_an_earlier_block_is_deleted():
    prev = previous_report((P1, P2, P3), P3)
    doc, changed = recheck.build_edited_document(blocks(P2, P3), {"b0": passages(P2)["b0"], "b1": {"id": "b1", "text": P3}}, [])
    carried = recheck.carry_over_matches(prev["matches"], doc, changed)
    assert doc["text"][carried[0]["input_offset"]["start"]:carried[0]["input_offset"]["end"]] == P3


def test_matches_in_changed_blocks_are_dropped():
    prev = previous_report((P1, P2, P3), P2)
    doc, changed = recheck.build_edited_document(blocks(P1, "Rewritten in my own words.", P3), passages(P1, P2, P3), [])
    assert recheck.carry_over_matches(prev["matches"], doc, changed) == []


def test_old_reports_without_offsets_still_carry_over():
    prev = previous_report((P1, P2), P2)
    for m in prev["matches"]:
        m.pop("input_offset")
    doc, changed = recheck.build_edited_document(blocks(P1, P2), passages(P1, P2), [])
    assert len(recheck.carry_over_matches(prev["matches"], doc, changed)) == 1


# --- the whole re-check -----------------------------------------------------------

def test_no_change_parity(no_search):
    prev = previous_report((P1, P2, P3), P2)
    result = recheck.run_recheck(prev, blocks(P1, P2, P3), passages(P1, P2, P3))
    assert result["overall_score"] == prev["overall_score"] > 0
    assert [m["input_offset"]["start"] for m in result["matches"]] == [m["input_offset"]["start"] for m in prev["matches"]]
    assert no_search == []  # nothing changed, nothing searched
    assert result["ai_detection"] == {"available": True, "overall_score": 12.0, "stale": True}
    assert result["recheck"] == {"changed_blocks": 0, "total_blocks": 3, "carried_matches": 1, "new_matches": 0}


def test_only_changed_text_is_searched(no_search):
    prev = previous_report((P1, P2, P3), P2)
    result = recheck.run_recheck(prev, blocks(P1, "My own sentence about attention models.", P3), passages(P1, P2, P3))
    assert no_search == [["My own sentence about attention models."]]
    assert result["overall_score"] == 0.0
    assert result["matches"] == []


def test_new_matches_are_merged_and_scored(monkeypatch):
    prev = previous_report((P1, P2, P3), P1)
    new_sentence = "Copied text from a newly found source, about attention models."

    def fake(document, runs, previous, progress_callback=None):
        start = document["text"].index(new_sentence)
        record = {**prev["matches"][0], "source_paper_id": "paper-2", "source_title": "New source",
                  "input_sentence": new_sentence,
                  "input_offset": {"start": start, "end": start + len(new_sentence), "section": "input_text"}}
        return {"matches": [record], "queries": ["q"], "cited_sources": [],
                "coverage": {"total_candidate_papers": 3, "checked_papers": 3, "unavailable_papers": 0,
                             "status": "complete"}}

    monkeypatch.setattr(recheck, "match_changed_text", fake)
    no_enrichment(monkeypatch)
    result = recheck.run_recheck(prev, blocks(P1, new_sentence, P3), passages(P1, P2, P3))
    assert {m["source_title"] for m in result["matches"]} == {"Attention Is All You Need", "New source"}
    assert len(result["matched_papers"]) == 2
    total = result["scoring"]["total_chars"]
    assert result["overall_score"] == round((len(P1) + len(new_sentence)) / total * 100, 2)
    assert result["queries"] == ["q"]


def test_reference_list_is_not_scored_after_a_recheck_either(no_search):
    ref = "A. Vaswani. 2017. Attention Is All You Need. In Proceedings of NeurIPS."
    texts = (P1, P2, "References", ref)
    stored = {**passages(*texts), "b2": {"id": "b2", "text": "References", "block_type": "heading", "level": 2}}
    document, _ = recheck.build_edited_document(blocks(*texts), stored, [])
    start = document["text"].index(ref)

    prev = previous_report(texts, P2)
    result = recheck.run_recheck(prev, blocks(*texts), stored)
    assert result["scoring"]["excluded_references"] == {"start": start, "end": start + len(ref), "chars": len(ref)}
    assert result["scoring"]["total_chars"] == len(document["text"]) - len(ref)
    assert result["overall_score"] == round(len(P2) / (len(document["text"]) - len(ref)) * 100, 2)


def test_empty_document_is_refused(no_search):
    with pytest.raises(ValueError):
        recheck.run_recheck(previous_report((P1,), P1), blocks("   "), passages(P1))


# --- POST /api/reports/{id}/recheck ---------------------------------------------------

@pytest.fixture
def api(monkeypatch):
    from fastapi.testclient import TestClient

    import app as api_app
    from auth import AuthedUser, verify_supabase_jwt

    api_app.app.dependency_overrides[verify_supabase_jwt] = lambda: AuthedUser(user_id="user-1", email=None, role="user", is_admin=False)
    api_app.limiter.enabled = False
    state = {"cost": "free", "charged": [], "checks": [], "replaced": [], "quota_ok": True}

    def quote(report_id, report, text):
        return {"tier": "free", "changed_ratio": 0.1, "change_limit": 0.3, "free_used": 0,
                "free_limit": 3, "free_left": 3, "cost": state["cost"]}

    def ensure(user_id, source):
        from fastapi import HTTPException
        if not state["quota_ok"]:
            raise HTTPException(status_code=402, detail="No checks left.")

    report = {"user_id": "user-1", "input": {"type": "pdf", "name": "essay.pdf"}, "created_at": "2026-10-01T00:00:00Z"}
    monkeypatch.setattr(api_app, "get_report", lambda rid: report if rid == "r-1" else {"user_id": "someone-else"})
    monkeypatch.setattr(api_app, "quote_recheck", quote)
    monkeypatch.setattr(api_app, "ensure_quota_available", ensure)
    monkeypatch.setattr(api_app, "version_belongs_to", lambda v, d: v != "00000000-0000-0000-0000-00000000dead")
    monkeypatch.setattr(api_app, "_previous_check", lambda rid, rep: previous_report((P1, P2), P2))
    monkeypatch.setattr(api_app, "fetch_passages", lambda rid: passages(P1, P2))
    monkeypatch.setattr(api_app, "insert_check", lambda **kw: state["checks"].append(kw))
    monkeypatch.setattr(api_app, "replace_report", lambda rid, rep, prev, unlocked_tier=None: state["replaced"].append((rid, unlocked_tier)))
    monkeypatch.setattr(api_app, "record_check_used", lambda uid, src: state["charged"].append(src))
    monkeypatch.setattr(api_app, "forget_quick_check_corpus", lambda rid: None)
    monkeypatch.setattr(recheck, "match_changed_text", lambda *a, **k: {
        "matches": [], "queries": [], "cited_sources": [], "coverage": {"status": "complete"}})
    import report_enrichment
    monkeypatch.setattr(report_enrichment, "enrich_report", lambda report, *a, **k: report.update(
        ai_detection={"available": True, "overall_score": 30.0}) or report)
    monkeypatch.setattr(api_app, "original_text", lambda rid, rep: "text before")

    # Run the job inline so the test sees its outcome.
    class InlineThread:
        def __init__(self, target, kwargs, daemon):
            self.target, self.kwargs = target, kwargs

        def start(self):
            self.target(**self.kwargs)

    monkeypatch.setattr(api_app.threading, "Thread", InlineThread)
    api_app._RECHECKS_RUNNING.clear()
    yield api_app, TestClient(api_app.app), state
    api_app.app.dependency_overrides.clear()
    api_app.limiter.enabled = True


BODY = {"blocks": [{"block_id": "b0", "text": P1}, {"block_id": "b1", "text": P2}], "expected_cost": "free"}


def test_free_recheck_records_history_and_charges_nothing(api):
    api_app, client, state = api
    res = client.post("/api/reports/r-1/recheck", json=BODY)
    assert res.status_code == 202
    job = api_app.get_job(res.json()["job_id"])
    assert (job["status"], job["report_id"]) == ("completed", "r-1")
    assert state["checks"][0]["kind"] == "free_recheck"
    assert state["checks"][0]["baseline_text"] == P1 + "\n\n" + P2
    # What went up or down, for Version History.
    check = state["checks"][0]
    assert (check["ai_score"], check["previous_ai_score"], check["previous_text"]) == (30.0, 12.0, "text before")
    assert check["previous_score"] == previous_report((P1, P2), P2)["overall_score"]
    assert state["charged"] == []
    assert api_app._RECHECKS_RUNNING == set()


def test_paid_recheck_charges_after_success_and_unlocks_the_credit_tier(api):
    api_app, client, state = api
    state["cost"] = "check"
    res = client.post("/api/reports/r-1/recheck", json={**BODY, "expected_cost": "check", "balance_source": "premium"})
    assert res.status_code == 202
    assert state["checks"][0]["kind"] == "paid_recheck"
    assert state["charged"] == ["premium"]
    assert state["replaced"] == [("r-1", "professional")]


def test_cost_change_is_refused(api):
    _api_app, client, state = api
    state["cost"] = "check"
    res = client.post("/api/reports/r-1/recheck", json=BODY)
    assert res.status_code == 409
    assert res.json()["detail"]["code"] == "cost_changed"
    assert res.json()["detail"]["quote"]["cost"] == "check"
    assert state["checks"] == []


def test_paid_recheck_needs_a_balance_and_quota(api):
    _api_app, client, state = api
    state["cost"] = "check"
    assert client.post("/api/reports/r-1/recheck", json={**BODY, "expected_cost": "check"}).status_code == 422
    state["quota_ok"] = False
    res = client.post("/api/reports/r-1/recheck", json={**BODY, "expected_cost": "check", "balance_source": "plan"})
    assert res.status_code == 402


def test_one_recheck_at_a_time(api):
    api_app, client, _state = api
    api_app._RECHECKS_RUNNING.add("r-1")
    res = client.post("/api/reports/r-1/recheck", json=BODY)
    assert res.status_code == 409
    assert res.json()["detail"]["code"] == "already_running"


def test_failed_recheck_costs_nothing(api, monkeypatch):
    api_app, client, state = api
    state["cost"] = "check"

    def boom(*a, **k):
        raise RuntimeError("search down")

    monkeypatch.setattr(recheck, "match_changed_text", boom)
    body = {**BODY, "blocks": [{"block_id": "b0", "text": "Totally different text now."}],
            "expected_cost": "check", "balance_source": "plan"}
    res = client.post("/api/reports/r-1/recheck", json=body)
    job = api_app.get_job(res.json()["job_id"])
    assert job["status"] == "failed"
    assert (state["charged"], state["checks"], state["replaced"]) == ([], [], [])
    assert api_app._RECHECKS_RUNNING == set()


def test_unrecorded_recheck_fails_without_replacing_the_report(api, monkeypatch):
    api_app, client, state = api

    def fail(**kw):
        raise api_app.RecheckStoreError("Couldn't save the re-check.")

    monkeypatch.setattr(api_app, "insert_check", fail)
    job = api_app.get_job(client.post("/api/reports/r-1/recheck", json=BODY).json()["job_id"])
    assert job["status"] == "failed"
    assert state["replaced"] == []


def test_ownership_and_version_checks(api):
    _api_app, client, _state = api
    assert client.post("/api/reports/r-2/recheck", json=BODY).status_code == 404
    res = client.post("/api/reports/r-1/recheck", json={**BODY, "version_id": "00000000-0000-0000-0000-00000000dead"})
    assert res.status_code == 400


def test_match_changed_text_wiring_without_sources(monkeypatch):
    """The real search half, with only the network stubbed: no candidates and
    no previous source files means nothing to match, not an error."""
    import search_paper.search_sources as search_sources

    monkeypatch.setattr(recheck, "_search_queries", lambda text: ["attention models"])
    monkeypatch.setattr(search_sources, "search_all_sources", lambda queries: [])
    monkeypatch.setattr(recheck, "previous_source_papers", lambda report: [])
    long_text = "A completely rewritten paragraph that is long enough to become a chunk of its own. " * 2
    doc, changed = recheck.build_edited_document(blocks(P1, long_text), passages(P1, P2), [])
    out = recheck.match_changed_text(doc, recheck.changed_runs(doc, changed), {"matches": []})
    assert out["matches"] == []
    assert out["queries"] == ["attention models"]
    assert out["coverage"]["total_candidate_papers"] == 0


def test_short_edits_skip_the_search(monkeypatch):
    called = []
    monkeypatch.setattr(recheck, "_search_queries", lambda text: called.append(text) or ["q"])
    doc, changed = recheck.build_edited_document(blocks(P1, "Tiny edit."), passages(P1, P2), [])
    out = recheck.match_changed_text(doc, recheck.changed_runs(doc, changed), {"matches": []})
    assert (out["matches"], called) == ([], [])


def test_restore_puts_an_earlier_check_back(api, monkeypatch):
    api_app, client, state = api
    stored = {"overall_score": 7.5, "matches": [], "user_id": "attacker", "unlocked_tier": "professional"}
    monkeypatch.setattr(api_app, "fetch_check_result", lambda cid, rid: stored if rid == "r-1" else None)
    restored = []
    monkeypatch.setattr(api_app, "replace_report", lambda rid, rep, prev, unlocked_tier=None: restored.append(rep))
    check_id = "11111111-1111-1111-1111-111111111111"

    res = client.post(f"/api/reports/r-1/checks/{check_id}/restore")
    assert res.status_code == 200
    assert res.json() == {"status": "restored", "overall_score": 7.5}
    assert "user_id" not in restored[0] and "unlocked_tier" not in restored[0]
    assert state["charged"] == []

    assert client.post(f"/api/reports/r-2/checks/{check_id}/restore").status_code == 404
    api_app._RECHECKS_RUNNING.add("r-1")
    assert client.post(f"/api/reports/r-1/checks/{check_id}/restore").status_code == 409


def test_replace_report_keeps_the_documents_own_fields(monkeypatch, tmp_path):
    """A re-check updates the score and status only: a renamed title, the
    project and the upload date stay as they are."""
    import report_store

    calls = []

    class Table:
        def __init__(self, name):
            self.name = name

        def __getattr__(self, op):
            def record(*args, **kwargs):
                calls.append((self.name, op, args))
                return self
            return record

        def execute(self):
            return type("R", (), {"data": []})()

    monkeypatch.setattr(report_store, "get_client", lambda: type("C", (), {"table": lambda self, n: Table(n)})())
    monkeypatch.setattr(report_store, "REPORT_DIR", tmp_path)
    previous = {"user_id": "u", "input": {"type": "pdf", "name": "essay.pdf"}, "created_at": "2026-10-01T00:00:00Z"}
    report_store.replace_report("r-9", {"overall_score": 12.0, "matches": [], "input_text": "x"}, previous)

    document_ops = [(op, args) for name, op, args in calls if name == "documents"]
    assert ("upsert" not in [op for op, _ in document_ops])
    assert ("update", ({"status": report_store._status_from_score(12.0), "similarity_score": 12.0},)) in document_ops
    assert (tmp_path / "r-9.json").exists()



def test_ai_detection_runs_again_on_the_edited_text(monkeypatch):
    import report_enrichment
    seen = []

    def fake_enrich(report, *a, **k):
        seen.append(report["input_text"])
        report["ai_detection"] = {"available": True, "overall_score": 41.0}
        return report

    monkeypatch.setattr(report_enrichment, "enrich_report", fake_enrich)
    monkeypatch.setattr(recheck, "match_changed_text", lambda *a, **k: {
        "matches": [], "queries": [], "cited_sources": [], "coverage": {"status": "complete"}})
    result = recheck.run_recheck(previous_report((P1, P2), P2), blocks(P1, P2 + " Edited."), passages(P1, P2))
    assert seen == [P1 + "\n\n" + P2 + " Edited."]
    assert recheck.ai_score(result) == 41.0


def test_previous_ai_result_is_kept_when_detection_cannot_run(monkeypatch):
    import report_enrichment
    monkeypatch.setattr(report_enrichment, "enrich_report", lambda report, *a, **k: report.update(
        ai_detection={"available": False, "reason": "disabled"}) or report)
    prev = previous_report((P1,), P1)
    prev["ai_detection"] = {"available": True, "overall_score": 12.0}
    result = recheck.run_recheck(prev, blocks(P1), passages(P1))
    assert result["ai_detection"] == {"available": True, "overall_score": 12.0, "stale": True}
    assert recheck.ai_score(result) is None  # a stale score isn't this text's score


def test_previous_sources_load_from_the_store_on_a_fresh_server(tmp_path, monkeypatch):
    """The report's own sources stay in the re-check pool when their chunks are
    only in the paper store, not on this server's disk."""
    import paper_cache
    import paper_store
    from plagiarism_matcher import load_candidate_chunks

    monkeypatch.setattr(paper_cache, "CHUNKS_DIR", str(tmp_path / "chunks"))
    store = paper_store.SqlitePaperStore(str(tmp_path / "store.db"))
    monkeypatch.setattr(paper_cache, "_store", store)
    store.save_chunks("paper-1", [{"chunk_id": "s0", "section": "abstract", "text": P2}], "pdf")

    papers = recheck.previous_source_papers(previous_report((P1, P2), P2))
    assert [p["paper_id"] for p in papers] == ["paper-1"]
    chunks = load_candidate_chunks(papers)
    assert [c["text"] for c in chunks] == [P2]
    assert chunks[0]["source_title"] == "Attention Is All You Need"
