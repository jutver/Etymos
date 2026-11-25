"""Unit tests for Supabase Storage retries and durable PDF upload recovery."""
from __future__ import annotations

import json
import threading
from types import SimpleNamespace

import httpcore
import httpx
import pytest
from storage3.exceptions import StorageApiError

import app as api_app
import report_store
import storage_retry
from storage_retry import PendingPdfUploadQueue, is_transient_storage_error, run_with_storage_retry


def _make_http_status_error(status_code: int) -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "https://example.supabase.co/storage/v1/object/documents/x.pdf")
    response = httpx.Response(status_code, request=request)
    return httpx.HTTPStatusError(f"HTTP {status_code}", request=request, response=response)


def test_transient_error_classification():
    # Network, timeout, and protocol errors are transient
    assert is_transient_storage_error(httpx.RemoteProtocolError("Server disconnected without sending a response."))
    assert is_transient_storage_error(httpcore.RemoteProtocolError("Server disconnected"))
    assert is_transient_storage_error(httpx.ReadTimeout("timed out"))
    assert is_transient_storage_error(httpx.ConnectError("connection refused"))
    assert is_transient_storage_error(httpx.WriteError("broken pipe"))
    assert is_transient_storage_error(ConnectionResetError("reset by peer"))
    assert is_transient_storage_error(TimeoutError("timed out"))

    # StorageApiError with int or string transient status codes (including Cloudflare 520-524)
    for code in (408, 425, 429, 500, 502, 503, 504, 520, 522, 524):
        assert is_transient_storage_error(StorageApiError("upstream error", "Upstream", code))
        assert is_transient_storage_error(StorageApiError("upstream error", "Upstream", str(code)))
        assert is_transient_storage_error(_make_http_status_error(code))

    # Wrapped cause
    wrapped = RuntimeError("storage request failed")
    wrapped.__cause__ = httpcore.RemoteProtocolError("Server disconnected")
    assert is_transient_storage_error(wrapped)

    # Permanent 4xx and application errors are NOT transient
    for code in (400, 401, 403, 404, 413, 415, 422):
        assert not is_transient_storage_error(StorageApiError("client error", "BadRequest", code))
        assert not is_transient_storage_error(StorageApiError("client error", "BadRequest", str(code)))
        assert not is_transient_storage_error(_make_http_status_error(code))

    assert not is_transient_storage_error(RuntimeError("Object not found"))
    assert not is_transient_storage_error(ValueError("bad argument"))
    assert not is_transient_storage_error(FileNotFoundError("missing.pdf"))


def test_run_with_storage_retry_succeeds_after_transient_failures():
    attempts = 0
    sleeps: list[float] = []

    def op():
        nonlocal attempts
        attempts += 1
        if attempts <= 2:
            raise httpx.RemoteProtocolError("Server disconnected without sending a response.")
        return "ok"

    result = run_with_storage_retry(
        op,
        label="Upload PDF",
        max_attempts=4,
        base_delay=1.0,
        max_delay=8.0,
        sleep_fn=sleeps.append,
        jitter_fn=lambda _a, _b: 0.0,
    )
    assert result == "ok"
    assert attempts == 3
    assert sleeps == [1.0, 2.0]


def test_run_with_storage_retry_does_not_retry_permanent_error():
    attempts = 0
    sleeps: list[float] = []

    def op():
        nonlocal attempts
        attempts += 1
        raise StorageApiError("Payload too large", "PayloadTooLarge", "413")

    with pytest.raises(StorageApiError):
        run_with_storage_retry(
            op,
            label="Upload PDF",
            max_attempts=4,
            base_delay=1.0,
            max_delay=8.0,
            sleep_fn=sleeps.append,
            jitter_fn=lambda _a, _b: 0.0,
        )
    assert attempts == 1
    assert sleeps == []


class _FakeStorageBucket:
    def __init__(self, handler=None):
        self.handler = handler
        self.uploads: list[tuple[str, bytes, dict | None]] = []
        self.removed: list[list[str]] = []

    def upload(self, path: str, data: bytes, file_options: dict | None = None):
        self.uploads.append((path, data, file_options))
        if self.handler is not None:
            return self.handler(len(self.uploads), path, data, file_options)
        return {"Key": path}

    def remove(self, paths: list[str]):
        self.removed.append(list(paths))
        return []


def test_upload_pdf_retries_inline_and_succeeds(tmp_path, monkeypatch):
    pdf_file = tmp_path / "source.pdf"
    payload = b"%PDF-1.4 inline retry payload"
    pdf_file.write_bytes(payload)

    fallback_dir = tmp_path / "fallback"
    fallback_dir.mkdir()
    sleeps: list[float] = []

    def upload_handler(attempt: int, _path: str, _data: bytes, _opts: dict | None):
        if attempt <= 2:
            raise httpx.RemoteProtocolError("Server disconnected without sending a response.")
        return {"Key": _path}

    bucket = _FakeStorageBucket(upload_handler)
    client = SimpleNamespace(storage=SimpleNamespace(from_=lambda _name: bucket))

    monkeypatch.setattr(api_app, "LOCAL_PDF_FALLBACK_DIR", fallback_dir)
    monkeypatch.setattr(api_app, "get_client", lambda: client)
    monkeypatch.setattr(storage_retry.time, "sleep", sleeps.append)

    api_app._upload_pdf("user-1", "report-1", pdf_file)

    assert len(bucket.uploads) == 3
    for path, data, opts in bucket.uploads:
        assert path == "user-1/report-1.pdf"
        assert data == payload
        assert opts == {"content-type": "application/pdf", "upsert": "true"}
    assert len(sleeps) == 2
    assert not (fallback_dir / "report-1.pdf").exists()
    assert not (fallback_dir / "report-1.pending.json").exists()


def test_upload_pdf_enqueues_durable_background_retry_and_recovers(tmp_path, monkeypatch):
    pdf_file = tmp_path / "source.pdf"
    payload = b"%PDF-1.4 background recovery payload"
    pdf_file.write_bytes(payload)

    fallback_dir = tmp_path / "fallback"
    fallback_dir.mkdir()
    now_holder = {"t": 1000.0}
    should_fail = {"flag": True}

    def upload_handler(_attempt: int, path: str, _data: bytes, _opts: dict | None):
        if should_fail["flag"]:
            raise httpx.RemoteProtocolError("Server disconnected without sending a response.")
        return {"Key": path}

    bucket = _FakeStorageBucket(upload_handler)
    client = SimpleNamespace(storage=SimpleNamespace(from_=lambda _name: bucket))

    queue = PendingPdfUploadQueue(
        fallback_dir_getter=lambda: fallback_dir,
        client_getter=lambda: client,
        bucket_getter=lambda: "documents",
        storage_path_fn=lambda uid, rid: f"{uid}/{rid}.pdf",
        initial_delay=15.0,
        max_backoff=600.0,
        max_attempts=5,
        now_fn=lambda: now_holder["t"],
        jitter_fn=lambda _a, _b: 0.0,
    )

    monkeypatch.setattr(api_app, "_pdf_upload_queue", queue)
    monkeypatch.setattr(api_app, "LOCAL_PDF_FALLBACK_DIR", fallback_dir)
    monkeypatch.setattr(api_app, "get_client", lambda: client)
    monkeypatch.setattr(storage_retry.time, "sleep", lambda _s: None)

    api_app._upload_pdf("user-1", "report-bg", pdf_file)

    assert len(bucket.uploads) == storage_retry.DEFAULT_STORAGE_RETRY_ATTEMPTS
    assert (fallback_dir / "report-bg.pdf").read_bytes() == payload
    meta = json.loads((fallback_dir / "report-bg.pending.json").read_text(encoding="utf-8"))
    assert meta["user_id"] == "user-1"
    assert meta["report_id"] == "report-bg"
    assert meta["attempts"] == 0
    assert meta["next_retry_at"] == pytest.approx(1015.0)

    # Not due yet -> does not upload
    wait = queue.process_due_once(now=1010.0)
    assert wait == pytest.approx(5.0)
    assert len(bucket.uploads) == storage_retry.DEFAULT_STORAGE_RETRY_ATTEMPTS

    # Recovery when due -> uploads and cleans up both local files
    should_fail["flag"] = False
    wait = queue.process_due_once(now=1015.0)
    assert wait is None
    assert len(bucket.uploads) == storage_retry.DEFAULT_STORAGE_RETRY_ATTEMPTS + 1
    assert not (fallback_dir / "report-bg.pdf").exists()
    assert not (fallback_dir / "report-bg.pending.json").exists()


def test_background_retry_backs_off_and_gives_up_keeping_fallback(tmp_path):
    fallback_dir = tmp_path / "fallback"
    fallback_dir.mkdir()
    now_holder = {"t": 100.0}

    def always_fail(_attempt: int, _path: str, _data: bytes, _opts: dict | None):
        raise StorageApiError("Bad Gateway", "BadGateway", 502)

    bucket = _FakeStorageBucket(always_fail)
    client = SimpleNamespace(storage=SimpleNamespace(from_=lambda _name: bucket))

    queue = PendingPdfUploadQueue(
        fallback_dir_getter=lambda: fallback_dir,
        client_getter=lambda: client,
        bucket_getter=lambda: "documents",
        storage_path_fn=lambda uid, rid: f"{uid}/{rid}.pdf",
        initial_delay=10.0,
        max_backoff=60.0,
        max_attempts=3,
        now_fn=lambda: now_holder["t"],
        jitter_fn=lambda _a, _b: 0.0,
    )

    payload = b"%PDF-1.4 outage"
    queue.enqueue("user-1", "report-giveup", payload, last_error="RemoteProtocolError")

    # Due at 110.0 -> bg attempt 1 fails -> backoff = min(60, 10 * 2^1) = 20 -> due at 130.0
    wait = queue.process_due_once(now=110.0)
    assert wait == pytest.approx(20.0)
    meta = json.loads((fallback_dir / "report-giveup.pending.json").read_text(encoding="utf-8"))
    assert meta["attempts"] == 1
    assert meta["next_retry_at"] == pytest.approx(130.0)

    # Due at 130.0 -> bg attempt 2 fails -> backoff = min(60, 10 * 2^2) = 40 -> due at 170.0
    wait = queue.process_due_once(now=130.0)
    assert wait == pytest.approx(40.0)
    meta = json.loads((fallback_dir / "report-giveup.pending.json").read_text(encoding="utf-8"))
    assert meta["attempts"] == 2
    assert meta["next_retry_at"] == pytest.approx(170.0)

    # Due at 170.0 -> bg attempt 3 (max_attempts=3) fails -> stops retrying, keeps fallback PDF
    wait = queue.process_due_once(now=170.0)
    assert wait is None
    assert not (fallback_dir / "report-giveup.pending.json").exists()
    assert (fallback_dir / "report-giveup.pdf").read_bytes() == payload


def test_upload_pdf_non_transient_error_skips_retry_and_background_queue(tmp_path, monkeypatch):
    pdf_file = tmp_path / "big.pdf"
    payload = b"%PDF-1.4 too large"
    pdf_file.write_bytes(payload)

    fallback_dir = tmp_path / "fallback"
    fallback_dir.mkdir()
    sleeps: list[float] = []

    def fail_413(_attempt: int, _path: str, _data: bytes, _opts: dict | None):
        raise StorageApiError("Payload too large", "PayloadTooLarge", 413)

    bucket = _FakeStorageBucket(fail_413)
    client = SimpleNamespace(storage=SimpleNamespace(from_=lambda _name: bucket))

    queue = PendingPdfUploadQueue(
        fallback_dir_getter=lambda: fallback_dir,
        client_getter=lambda: client,
        bucket_getter=lambda: "documents",
        storage_path_fn=lambda uid, rid: f"{uid}/{rid}.pdf",
    )

    monkeypatch.setattr(api_app, "_pdf_upload_queue", queue)
    monkeypatch.setattr(api_app, "LOCAL_PDF_FALLBACK_DIR", fallback_dir)
    monkeypatch.setattr(api_app, "get_client", lambda: client)
    monkeypatch.setattr(storage_retry.time, "sleep", sleeps.append)

    api_app._upload_pdf("user-1", "report-413", pdf_file)

    assert len(bucket.uploads) == 1
    assert sleeps == []
    assert (fallback_dir / "report-413.pdf").read_bytes() == payload
    assert not (fallback_dir / "report-413.pending.json").exists()


def test_upload_pdf_without_supabase_writes_local_fallback_only(tmp_path, monkeypatch):
    pdf_file = tmp_path / "local.pdf"
    payload = b"%PDF-1.4 local dev"
    pdf_file.write_bytes(payload)

    fallback_dir = tmp_path / "fallback"
    fallback_dir.mkdir()

    monkeypatch.setattr(api_app, "LOCAL_PDF_FALLBACK_DIR", fallback_dir)
    monkeypatch.setattr(api_app, "get_client", lambda: None)

    api_app._upload_pdf("user-1", "report-local", pdf_file)

    assert (fallback_dir / "report-local.pdf").read_bytes() == payload
    assert not (fallback_dir / "report-local.pending.json").exists()


def test_delete_and_purge_cancel_pending_uploads(tmp_path, monkeypatch):
    fallback_dir = tmp_path / "fallback"
    fallback_dir.mkdir()

    started = threading.Event()
    release = threading.Event()

    def upload_handler(_attempt: int, path: str, _data: bytes, _opts: dict | None):
        if path == "user-1/inflight.pdf":
            started.set()
            release.wait(timeout=5)
        return {"Key": path}

    bucket = _FakeStorageBucket(upload_handler)
    client = SimpleNamespace(
        storage=SimpleNamespace(
            from_=lambda _name: SimpleNamespace(
                upload=bucket.upload,
                remove=bucket.remove,
                list=lambda _uid: [],
            )
        )
    )

    queue = PendingPdfUploadQueue(
        fallback_dir_getter=lambda: fallback_dir,
        client_getter=lambda: client,
        bucket_getter=lambda: "documents",
        storage_path_fn=lambda uid, rid: f"{uid}/{rid}.pdf",
        initial_delay=10.0,
        now_fn=lambda: 100.0,
        jitter_fn=lambda _a, _b: 0.0,
    )

    monkeypatch.setattr(api_app, "_pdf_upload_queue", queue)
    monkeypatch.setattr(api_app, "LOCAL_PDF_FALLBACK_DIR", fallback_dir)
    monkeypatch.setattr(api_app, "get_client", lambda: client)

    # Queue items for user-1 and user-2
    queue.enqueue("user-1", "r-del", b"%PDF-1.4 del")
    queue.enqueue("user-1", "r-u1-a", b"%PDF-1.4 u1a")
    queue.enqueue("user-2", "r-u2", b"%PDF-1.4 u2")

    # _delete_pdf removes r-del pending metadata + PDF
    api_app._delete_pdf("user-1", "r-del")
    assert not (fallback_dir / "r-del.pending.json").exists()
    assert not (fallback_dir / "r-del.pdf").exists()

    # _purge_user_storage cancels only user-1's remaining pending uploads
    api_app._purge_user_storage(client, "user-1")
    assert not (fallback_dir / "r-u1-a.pending.json").exists()
    assert not (fallback_dir / "r-u1-a.pdf").exists()
    assert (fallback_dir / "r-u2.pending.json").exists()
    assert (fallback_dir / "r-u2.pdf").exists()

    # Clean up r-u2 before testing in-flight cancellation
    queue.cancel("r-u2", remove_pdf=True)

    # In-flight cancellation: delete while upload is blocked mid-request
    queue.enqueue("user-1", "inflight", b"%PDF-1.4 inflight")
    worker_thread = threading.Thread(target=lambda: queue.process_due_once(now=115.0))
    worker_thread.start()
    assert started.wait(timeout=5)
    queue.cancel("inflight", remove_pdf=True)
    release.set()
    worker_thread.join(timeout=5)

    assert ["user-1/inflight.pdf"] in bucket.removed
    assert not (fallback_dir / "inflight.pending.json").exists()
    assert not (fallback_dir / "inflight.pdf").exists()


def test_stored_file_download_retries_transient_error(tmp_path, monkeypatch):
    downloads = 0
    sleeps: list[float] = []
    checked = []

    class FlakyDownloadBucket:
        def __init__(self):
            self.removed = []

        def download(self, path: str):
            nonlocal downloads
            downloads += 1
            if downloads == 1:
                raise httpx.RemoteProtocolError("Server disconnected")
            return b"%PDF-1.4 downloaded after retry"

        def remove(self, paths):
            self.removed.extend(paths)

    bucket = FlakyDownloadBucket()
    client = SimpleNamespace(storage=SimpleNamespace(from_=lambda _name: bucket))
    monkeypatch.setattr(api_app, "get_client", lambda: client)
    monkeypatch.setattr(storage_retry.time, "sleep", sleeps.append)
    monkeypatch.setattr(
        api_app,
        "run_pdf_job",
        lambda **kw: checked.append(
            {
                "job_id": kw["job_id"],
                "bytes": open(kw["pdf_path"], "rb").read(),
            }
        ),
    )

    job_id = api_app.create_job(input_type="pdf", input_name="paper.pdf", user_id="user-1")
    api_app.run_stored_file_job(
        job_id=job_id,
        storage_path="user-1/uploads/paper.pdf",
        original_name="paper.pdf",
        user_id="user-1",
        balance_source="plan",
        input_type="pdf",
    )

    assert downloads == 2
    assert len(sleeps) == 1
    assert checked[0]["bytes"] == b"%PDF-1.4 downloaded after retry"
    assert bucket.removed == ["user-1/uploads/paper.pdf"]


def test_extract_and_upload_images_retries_transient_error(monkeypatch):
    upload_attempts = 0
    sign_attempts = 0
    sleeps: list[float] = []

    class FlakyImageBucket:
        def upload(self, path: str, data: bytes, file_options=None):
            nonlocal upload_attempts
            upload_attempts += 1
            if upload_attempts == 1:
                raise httpx.RemoteProtocolError("Server disconnected")
            return {"Key": path}

        def create_signed_url(self, path: str, expires_in: int):
            nonlocal sign_attempts
            sign_attempts += 1
            if sign_attempts == 1:
                raise httpx.ReadTimeout("timed out")
            return {"signedURL": f"https://storage.test/{path}"}

    bucket = FlakyImageBucket()
    client = SimpleNamespace(storage=SimpleNamespace(from_=lambda _name: bucket))
    monkeypatch.setattr(report_store, "get_client", lambda: client)
    monkeypatch.setattr(storage_retry.time, "sleep", sleeps.append)

    report = {
        "document": {
            "blocks": [
                {
                    "id": "fig-1",
                    "type": "image",
                    "_image_bytes": b"\x89PNG\r\n\x1a\n",
                    "_image_ext": "png",
                }
            ]
        }
    }
    report_store._extract_and_upload_images("report-img", report, "user-1")

    block = report["document"]["blocks"][0]
    assert upload_attempts == 2
    assert sign_attempts == 2
    assert len(sleeps) == 2
    assert block["image_url"] == "https://storage.test/user-1/report-img/images/0.png"
    assert "_image_bytes" not in block
    assert "_image_ext" not in block
