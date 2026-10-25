"""Recording a finished re-check in backend/api/recheck_store.py: one retry
after a dropped connection, under the same row id."""
from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest

import recheck_store


class FakeChecks:
    """document_checks that fails its first `failures` writes."""

    def __init__(self, failures: int, error: Exception):
        self.failures = failures
        self.error = error
        self.writes: list[tuple[dict, dict]] = []

    def upsert(self, row, **kwargs):
        self.writes.append((row, kwargs))
        return self

    def execute(self):
        if len(self.writes) <= self.failures:
            raise self.error
        return SimpleNamespace(data=[])


def record(monkeypatch, checks: FakeChecks) -> None:
    monkeypatch.setattr(recheck_store, "get_client", lambda: SimpleNamespace(table=lambda name: checks))
    recheck_store.insert_check(document_id="d", version_id=None, kind="free_recheck", balance_source=None,
                               changed_ratio=0.1, similarity_score=50.0, baseline_text="text",
                               result={"matches": []})


def test_a_dropped_connection_is_retried_under_the_same_id(monkeypatch):
    checks = FakeChecks(1, httpx.RemoteProtocolError("Server disconnected"))
    record(monkeypatch, checks)
    (first, kwargs), (second, _) = checks.writes
    assert first["id"] == second["id"]
    assert kwargs == {"on_conflict": "id", "ignore_duplicates": True}


def test_a_second_dropped_connection_fails_the_recheck(monkeypatch):
    checks = FakeChecks(2, httpx.RemoteProtocolError("Server disconnected"))
    with pytest.raises(recheck_store.RecheckStoreError):
        record(monkeypatch, checks)
    assert len(checks.writes) == 2


def test_a_rejected_row_is_not_retried(monkeypatch):
    checks = FakeChecks(1, RuntimeError("violates check constraint"))
    with pytest.raises(recheck_store.RecheckStoreError):
        record(monkeypatch, checks)
    assert len(checks.writes) == 1


class Query:
    """A chained Supabase query answering `data` (or raising `error`), noting
    which filters it got."""

    def __init__(self, data, error=None, seen=None):
        self.data, self.error, self.seen = data, error, seen if seen is not None else []

    def __getattr__(self, op):
        return lambda *args, **kwargs: self.seen.append((op, args)) or self

    def execute(self):
        if self.error:
            raise self.error
        return SimpleNamespace(data=self.data)


def test_the_current_check_is_the_one_the_document_names(monkeypatch):
    seen = []
    tables = {"documents": Query({"current_check_id": "c-1"}),
              "document_checks": Query([{"result": {"matches": [], "overall_score": 5.0}}], seen=seen)}
    monkeypatch.setattr(recheck_store, "get_client", lambda: SimpleNamespace(table=tables.get))
    assert recheck_store.current_check_result("d") == {"matches": [], "overall_score": 5.0}
    assert ("eq", ("id", "c-1")) in seen


def test_without_a_current_check_the_newest_is_used(monkeypatch):
    seen = []
    tables = {"documents": Query({"current_check_id": None}),
              "document_checks": Query([{"result": {"matches": []}}], seen=seen)}
    monkeypatch.setattr(recheck_store, "get_client", lambda: SimpleNamespace(table=tables.get))
    assert recheck_store.current_check_result("d") == {"matches": []}
    assert ("order", ("created_at",)) in seen


def test_an_unknown_check_history_stops_the_recheck(monkeypatch):
    tables = {"document_checks": Query(None, error=httpx.RemoteProtocolError("Server disconnected"))}
    monkeypatch.setattr(recheck_store, "get_client", lambda: SimpleNamespace(table=tables.get))
    with pytest.raises(recheck_store.RecheckStoreError):
        recheck_store.has_stored_result("d")
    tables["document_checks"] = Query([{"id": "c-1"}])
    assert recheck_store.has_stored_result("d") is True
    tables["document_checks"] = Query([])
    assert recheck_store.has_stored_result("d") is False
