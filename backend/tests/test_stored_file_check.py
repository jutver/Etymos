"""POST /api/check/stored-file: check a file the browser uploaded to Supabase
Storage, instead of sending it through api.etymos.site."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

USER = "11111111-1111-1111-1111-111111111111"


class FakeBucket:
    def __init__(self, files):
        self.files, self.removed = files, []

    def download(self, path):
        if path not in self.files:
            raise RuntimeError("Object not found")
        return self.files[path]

    def remove(self, paths):
        self.removed.extend(paths)


@pytest.fixture
def api(monkeypatch):
    from fastapi.testclient import TestClient

    import app as api_app
    from auth import AuthedUser, verify_supabase_jwt

    api_app.app.dependency_overrides[verify_supabase_jwt] = lambda: AuthedUser(user_id=USER, email=None, role="user", is_admin=False)
    api_app.limiter.enabled = False

    bucket = FakeBucket({f"{USER}/uploads/abc.pdf": b"%PDF-1.4 fake"})
    client = SimpleNamespace(storage=SimpleNamespace(from_=lambda name: bucket))
    monkeypatch.setattr(api_app, "get_client", lambda: client)
    monkeypatch.setattr(api_app, "ensure_quota_available", lambda uid, src: None)

    checked = []

    def fake_run_pdf_job(**kw):
        with open(kw["pdf_path"], "rb") as f:
            checked.append({**kw, "bytes": f.read()})

    monkeypatch.setattr(api_app, "run_pdf_job", fake_run_pdf_job)

    class InlineThread:
        def __init__(self, target, kwargs, daemon):
            self.target, self.kwargs = target, kwargs

        def start(self):
            self.target(**self.kwargs)

    monkeypatch.setattr(api_app.threading, "Thread", InlineThread)
    yield api_app, TestClient(api_app.app), bucket, checked
    api_app.app.dependency_overrides.clear()
    api_app.limiter.enabled = True


def body(path: str, **over):
    return {"storage_path": path, "file_name": "Report.pdf", "balance_source": "plan", **over}


def test_checks_the_uploaded_file_and_removes_it(api):
    _api_app, client, bucket, checked = api
    res = client.post("/api/check/stored-file", json=body(f"{USER}/uploads/abc.pdf"))
    assert res.status_code == 202
    assert res.json()["input_type"] == "pdf"
    assert checked[0]["bytes"] == b"%PDF-1.4 fake"
    assert (checked[0]["original_name"], checked[0]["user_id"], checked[0]["balance_source"]) == ("Report.pdf", USER, "plan")
    assert bucket.removed == [f"{USER}/uploads/abc.pdf"]


@pytest.mark.parametrize("path", [
    "22222222-2222-2222-2222-222222222222/uploads/abc.pdf",  # someone else's folder
    f"{USER}/abc.pdf",  # outside uploads (e.g. a checked report's PDF)
    f"{USER}/uploads/../other/abc.pdf",
    f"{USER}/uploads/sub/abc.pdf",
    f"{USER}/uploads/abc.exe",
])
def test_rejects_paths_outside_the_users_uploads(api, path):
    _api_app, client, bucket, checked = api
    assert client.post("/api/check/stored-file", json=body(path)).status_code == 400
    assert checked == [] and bucket.removed == []


def test_missing_upload_fails_the_job_without_a_check(api):
    api_app, client, bucket, checked = api
    res = client.post("/api/check/stored-file", json=body(f"{USER}/uploads/gone.pdf"))
    job = api_app.get_job(res.json()["job_id"])
    assert job["status"] == "failed"
    assert checked == []
    assert bucket.removed == [f"{USER}/uploads/gone.pdf"]


def test_no_quota_is_refused_before_anything_runs(api, monkeypatch):
    api_app, client, _bucket, checked = api
    from fastapi import HTTPException

    def no_quota(uid, src):
        raise HTTPException(status_code=402, detail="No checks left.")

    monkeypatch.setattr(api_app, "ensure_quota_available", no_quota)
    assert client.post("/api/check/stored-file", json=body(f"{USER}/uploads/abc.pdf")).status_code == 402
    assert checked == []


def test_docx_uploads_are_checked_as_docx(api):
    _api_app, client, bucket, checked = api
    bucket.files[f"{USER}/uploads/x.docx"] = b"PK fake docx"
    res = client.post("/api/check/stored-file", json=body(f"{USER}/uploads/x.docx", file_name="x.docx"))
    assert res.json()["input_type"] == "docx"
    assert checked[0]["input_type"] == "docx"


def test_users_never_see_raw_internal_errors():
    import app as api_app

    assert api_app.user_error_message(ValueError("The document is empty.")) == "The document is empty."
    raw = RuntimeError("Failed to import transformers.models.qwen2 ... /Users/x/.venv/lib/scipy/_spropack.so")
    assert api_app.user_error_message(raw) == api_app.GENERIC_CHECK_ERROR
    # A library's ValueError subclass is still internal.
    class LibError(ValueError):
        pass
    assert api_app.user_error_message(LibError("/srv/path detail")) == api_app.GENERIC_CHECK_ERROR
