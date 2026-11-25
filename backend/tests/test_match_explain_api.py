"""Tests for POST /api/reports/{report_id}/matches/{match_id}/explain."""
from __future__ import annotations

from types import SimpleNamespace

from fastapi.testclient import TestClient

import ai_explain
import app as api_app
import report_store
from auth import AuthedUser, verify_supabase_jwt


USER_A = AuthedUser(user_id="user-a-0001", email="a@etymos.site", role="user", is_admin=False)
USER_B = AuthedUser(user_id="user-b-0002", email="b@etymos.site", role="user", is_admin=False)
ADMIN_USER = AuthedUser(user_id="admin-0001", email="admin@etymos.site", role="admin", is_admin=True)


class _ExplainFakeQuery:
    def __init__(self, db, table_name):
        self.db = db
        self.table_name = table_name
        self.filters = []
        self.op = "select"
        self.payload = None
        self._single = False

    def select(self, *_):
        self.op = "select"
        return self

    def eq(self, col, val):
        self.filters.append(lambda r: str(r.get(col) or "") == str(val))
        return self

    def order(self, *_a, **_kw):
        return self

    def maybe_single(self):
        self._single = True
        return self

    def update(self, payload):
        self.op = "update"
        self.payload = payload
        return self

    def execute(self):
        rows = self.db.tables[self.table_name]
        matched = [r for r in rows if all(f(r) for f in self.filters)]
        if self.op == "select":
            if self._single:
                return SimpleNamespace(data=dict(matched[0]) if matched else None)
            return SimpleNamespace(data=[dict(r) for r in matched])
        if self.op == "update":
            for r in matched:
                r.update(self.payload)
            return SimpleNamespace(data=[dict(r) for r in matched])
        raise AssertionError(self.op)


class _ExplainFakeDB:
    def __init__(self, *, plan_tier: str = "student", unlocked_tier: str | None = None):
        self.tables = {
            "profiles": [
                {"id": USER_A.user_id, "plan_tier": plan_tier},
                {"id": USER_B.user_id, "plan_tier": "professional"},
            ],
            "documents": [
                {
                    "id": "rep-1",
                    "user_id": USER_A.user_id,
                    "title": "Sample Paper",
                    "file_name": "paper.pdf",
                    "word_count": 500,
                    "uploaded_at": "2026-11-24T12:00:00Z",
                    "similarity_score": 45.0,
                    "status": "high",
                    "unlocked_tier": unlocked_tier,
                }
            ],
            "document_matches": [
                {
                    "id": "11111111-1111-1111-1111-111111111111",
                    "document_id": "rep-1",
                    "severity": "high",
                    "match_percent": 98.0,
                    "source_title": "(PDF) ViHateT5: Enhancing Hate Speech Detection ... · Hugging FaceViHateT5",
                    "source_kind": "academic",
                    "user_snippet": "This process is applied consistently across all test splits in our study.",
                    "source_snippet": "This process is applied consistently across all test splits in our study.",
                    "explanation": "TEMPLATE",
                    "explanation_facts": {"kind": "identical", "label": "likely_plagiarism", "title": "ViHateT5", "shared": 13, "total": 13, "phrase": "", "semantic": 98},
                    "sort_order": 0,
                    "ai_explanations": None,
                }
            ],
        }

    def table(self, name):
        return _ExplainFakeQuery(self, name)


def _setup(monkeypatch, db, active_user=USER_A):
    api_app.clear_explain_cache()
    with report_store._LOCK:
        report_store._REPORTS.clear()
    monkeypatch.setattr(report_store, "get_client", lambda: db)
    monkeypatch.setattr(api_app, "get_client", lambda: db)
    api_app.app.dependency_overrides[verify_supabase_jwt] = lambda: active_user
    return TestClient(api_app.app)


def test_explain_match_requires_auth_and_enforces_owner_and_free_tier(monkeypatch):
    db = _ExplainFakeDB(plan_tier="free", unlocked_tier=None)
    api_app.app.dependency_overrides.clear()
    client_no_auth = TestClient(api_app.app)
    assert client_no_auth.post("/api/reports/rep-1/matches/11111111-1111-1111-1111-111111111111/explain", json={"language": "en"}).status_code == 401

    try:
        # Cross-user sees 404 (not 403) to avoid ID enumeration
        c_other = _setup(monkeypatch, db, active_user=USER_B)
        assert c_other.post("/api/reports/rep-1/matches/11111111-1111-1111-1111-111111111111/explain", json={"language": "en"}).status_code == 404

        # Free owner on locked doc gets 403
        c_free = _setup(monkeypatch, db, active_user=USER_A)
        assert c_free.post("/api/reports/rep-1/matches/11111111-1111-1111-1111-111111111111/explain", json={"language": "en"}).status_code == 403

        # Unlocked doc allows access even for free-plan owner; ignores other tasks' Gemini keys
        db.tables["documents"][0]["unlocked_tier"] = "student"
        report_store.set_cached_unlocked_tier("rep-1", "student")
        monkeypatch.delenv("GEMINI_EXPLAIN_API_KEY", raising=False)
        monkeypatch.setenv("GEMINI_EXTRACTION_API_KEY", "extraction-key")
        monkeypatch.setenv("GEMINI_REWRITE_API_KEY", "rewrite-key")
        monkeypatch.setenv("GEMINI_API_KEY", "legacy-global-key")
        res = c_free.post("/api/reports/rep-1/matches/11111111-1111-1111-1111-111111111111/explain", json={"language": "en"})
        assert res.status_code == 200
        assert res.json()["source"] == "facts"
    finally:
        api_app.app.dependency_overrides.clear()


def test_explain_match_resolves_uuid_and_synthetic_ids_caches_per_language_and_falls_back(monkeypatch):
    db = _ExplainFakeDB(plan_tier="student")
    client = _setup(monkeypatch, db, active_user=USER_A)
    monkeypatch.setenv("GEMINI_EXPLAIN_API_KEY", "dedicated-explain-key")

    calls = []

    class _FakeResp:
        def __init__(self, status_code, payload):
            self.status_code = status_code
            self._payload = payload

        def json(self):
            return self._payload

    def fake_post(url, headers=None, json=None, timeout=None):
        calls.append((url, headers, json, timeout))
        user_msg = json["contents"][0]["parts"][0]["text"]
        lang = "vi" if "in Vietnamese" in user_msg else "en"
        return _FakeResp(
            200,
            {
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {
                                    "text": f"[{lang}] This passage copies the source word for word; cite it or reword it."
                                    if lang == "en"
                                    else "Đoạn này trùng nguyên văn với nguồn \"ViHateT5: Enhancing Hate Speech Detection\"; hãy trích dẫn hoặc viết lại."
                                }
                            ]
                        }
                    }
                ]
            },
        )

    monkeypatch.setattr(ai_explain.httpx, "post", fake_post)

    try:
        # 1. First request in Vietnamese using UUID -> calls Gemini, persists to DB & cache
        r1 = client.post("/api/reports/rep-1/matches/11111111-1111-1111-1111-111111111111/explain", json={"language": "vi"})
        assert r1.status_code == 200
        j1 = r1.json()
        assert j1["source"] == "llm:gemini"
        assert j1["cached"] is False
        assert j1["language"] == "vi"
        assert calls[0][1]["x-goog-api-key"] == "dedicated-explain-key"
        assert db.tables["document_matches"][0]["ai_explanations"]["vi"]["text"] == j1["explanation"]

        # 2. Synthetic ID (`rep-1-match-0` / `m-0`) resolves the same row and hits cache cleanly!
        r2 = client.post("/api/reports/rep-1/matches/rep-1-match-0/explain", json={"language": "vi"})
        assert r2.status_code == 200
        assert r2.json()["cached"] is True
        assert len(calls) == 1

        # 3. Switching to English hits Gemini again with language="en"
        r3 = client.post("/api/reports/rep-1/matches/m-0/explain", json={"language": "en"})
        assert r3.status_code == 200
        assert r3.json()["cached"] is False
        assert r3.json()["language"] == "en"
        assert len(calls) == 2

        # 4. Simulate rate limit (429) on a fresh cache clear for a new language-like call -> graceful HTTP 200 facts fallback
        api_app.clear_explain_cache()
        db.tables["document_matches"][0]["ai_explanations"] = None
        monkeypatch.setattr(ai_explain.httpx, "post", lambda *a, **k: _FakeResp(429, {}))
        r4 = client.post("/api/reports/rep-1/matches/11111111-1111-1111-1111-111111111111/explain", json={"language": "en"})
        assert r4.status_code == 200
        assert r4.json()["source"] == "facts"
        assert r4.json()["cached"] is False
        assert "12-word sentence" in r4.json()["explanation"]
        # Fallback never poisons persisted DB cache
        assert db.tables["document_matches"][0]["ai_explanations"] is None
    finally:
        api_app.app.dependency_overrides.clear()
