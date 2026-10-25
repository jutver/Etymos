

import logging
import os
import shutil
import tempfile
import threading
import traceback
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Optional
from uuid import UUID
import sys
from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel, Field
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

# Must be set before torch starts CUDA. Lets the allocator grow segments in
# place, so memory freed when gpu_models unloads a model can be reused by a
# differently shaped one instead of sitting fragmented (matters on 12 GB).
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

# Cấu hình hệ thống
sys.path.append(str(Path(__file__).parent.parent))
sys.path.append(str(Path(__file__).parent))
from job_manager import active_count, create_job, get_job, make_progress_callback, make_queue_callback, update_job
from gpu_queue import gpu_slot
import gpu_models
from report_store import delete_report, get_report, list_reports, save_report, set_cached_unlocked_tier
from main import check_pdf_plagiarism, check_docx_plagiarism
from doan_van import check_text_plagiarism
from ai_rewrite import RewriteUnavailable, register_flag as register_rewrite_flag, rewrite_sentence
from quick_check import MAX_QUICK_CHECK_CHARS, check_passage, corpus_from_sources, quick_check_report_passage
from quick_check import warm_up as warm_up_quick_check
from report_store import get_local_report_file
from ai_explain import register_flag as register_explain_flag
from report_enrichment import register_flags as register_enrichment_flags
from citations import DEFAULT_REFERENCE_HEADING, add_citation
from rate_limit import limiter
from recovery_email import router as recovery_email_router
from payments import router as payments_router
from support import router as support_router
import support_inbound
import notifications
from auth import AuthedUser, require_owner_or_admin, verify_supabase_jwt
from supabase_client import get_client
from usage import credit_tier, ensure_quota_available, record_check_used, unlock_document_with_credit
from recheck_quota import TIER_RANK, original_text, quote_recheck
from recheck_store import (
    RecheckStoreError,
    fetch_check_result,
    current_check_result,
    fetch_passages,
    has_stored_result,
    insert_check,
    version_belongs_to,
)
from report_store import ReportStoreError, replace_report
from quick_check import forget_report as forget_quick_check_corpus
import marker_preview
from marker_preview_store import (
    get_marker_preview,
    has_docx_ready,
    init_marker_preview,
    mark_marker_preview_failed,
    mark_marker_preview_ready,
)

logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(_: FastAPI):
    """Register backend-owned feature flags so they appear in the admin
    portal's Config → Feature Flags screen. Idempotent, never overwrites
    an admin's chosen value, and a no-op when Supabase isn't configured."""
    try:
        register_rewrite_flag()
    except Exception:
        logger.exception("Feature flag registration failed; using code defaults.")
    try:
        register_enrichment_flags()
        register_explain_flag()
    except Exception:
        logger.exception("AI detection/explanation flag registration failed; using code defaults.")
    # Expiry reminders, receipts the webhook missed, verification results...
    notifications.start_scheduler()
    # Support inbox (email replies -> tickets) and auto-closing tickets.
    support_inbound.start()
    yield


app = FastAPI(title="Academic Plagiarism Checker API", version="0.1.0", lifespan=lifespan)

# Cấu hình CORS
# No wildcard fallback: ALLOWED_ORIGINS must be set explicitly. Defaults to
# the local Vite dev server ports for apps/web and apps/admin so local dev
# keeps working out of the box; any deployed environment MUST set
# ALLOWED_ORIGINS (see docs/DEPLOY_BACKEND.md).
_DEFAULT_DEV_ORIGINS = "http://localhost:5173,http://localhost:5174"
allowed_origins_env = os.getenv("ALLOWED_ORIGINS")
if not allowed_origins_env:
    logger.warning(
        "ALLOWED_ORIGINS is not set — defaulting to local dev origins (%s). "
        "Set ALLOWED_ORIGINS explicitly in any deployed environment.",
        _DEFAULT_DEV_ORIGINS,
    )
    allowed_origins_env = _DEFAULT_DEV_ORIGINS
allowed_origins = [origin.strip() for origin in allowed_origins_env.split(",") if origin.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Cấu hình rate limiting (slowapi). The limiter lives in rate_limit.py so
# route modules outside this file (recovery_email.py, payments.py) share the instance
# slowapi's middleware enforces. Limits are configurable via env vars.
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)
app.include_router(recovery_email_router)
app.include_router(payments_router)
app.include_router(support_router)

RATE_LIMIT_CHECK_PDF = os.getenv("RATE_LIMIT_CHECK_PDF", "10/hour")
RATE_LIMIT_CHECK_TEXT = os.getenv("RATE_LIMIT_CHECK_TEXT", "20/hour")
RATE_LIMIT_AI_REWRITE = os.getenv("RATE_LIMIT_AI_REWRITE", "30/hour")
# Quick check runs after every accepted rewrite and every hand edit of a
# flagged passage, but only against already-downloaded sources (no search,
# no download), so it can afford a loose limit.
RATE_LIMIT_QUICK_CHECK = os.getenv("RATE_LIMIT_QUICK_CHECK", "300/hour")
# Citing is a cheap pure-text transform, so it gets a much looser limit
# than the model-backed endpoints — a user adding a bibliography can
# easily insert dozens of citations in one editing session.
RATE_LIMIT_CITE = os.getenv("RATE_LIMIT_CITE", "300/hour")
# A re-check quote is read-only (a diff plus two small lookups), asked for each
# time the user opens the Save & re-check dialog.
RATE_LIMIT_RECHECK_QUOTE = os.getenv("RATE_LIMIT_RECHECK_QUOTE", "120/hour")
# A re-check searches and downloads sources for the changed paragraphs, like
# a text check.
RATE_LIMIT_RECHECK = os.getenv("RATE_LIMIT_RECHECK", "20/hour")

# Cấu hình AI Gemini.
#
# Each Gemini-capable module configures the SDK itself at first use
# (llm_metadata._ensure_genai_configured, ai_rewrite.rewrite_with_gemini),
# so there is nothing to configure here — only a startup warning. Without
# a key the backend still works entirely on the local Qwen2.5 model; only
# the opt-in Gemini feature flags become unavailable.
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if not GEMINI_API_KEY:
    logger.warning(
        "GEMINI_API_KEY is not set; the Gemini feature flags "
        "(gemini_metadata_extraction, gemini_ai_rewrite) cannot be used. "
        "The local Qwen2.5 model handles both paths."
    )

# Supabase Storage bucket for uploaded/checked PDFs (see
# supabase/migrations/20260716120000_student_verification_and_audit_log.sql
# for the `documents` bucket + storage.objects policies). Path convention:
# `{user_id}/{report_id}.pdf`.
DOCUMENTS_BUCKET = os.getenv("SUPABASE_STORAGE_BUCKET", "documents")

# Local fallback directory, used ONLY when Supabase isn't configured (e.g.
# local dev without credentials — see PLAN.md: "No live Supabase/VPS
# credentials in this environment"). Any real deployment relies on Storage,
# not local disk.
LOCAL_PDF_FALLBACK_DIR = Path(os.getenv("LOCAL_PDF_FALLBACK_DIR", "./storage/processed_pdfs"))
LOCAL_PDF_FALLBACK_DIR.mkdir(parents=True, exist_ok=True)

# Where marker-pdf's per-report HTML/docx preview output lives (see
# marker_preview.py + run_marker_preview_job below). Local disk only — like
# job_manager.py's in-memory job table, this is a nicer-to-have display
# layer, not the check result itself, so losing it on a process restart is
# an acceptable tradeoff (see marker_preview_store.py's module docstring).
MARKER_PREVIEW_DIR = Path(os.getenv("MARKER_PREVIEW_DIR", "./storage/marker_previews"))
MARKER_PREVIEW_DIR.mkdir(parents=True, exist_ok=True)


def _storage_path(user_id: str, report_id: str) -> str:
    return f"{user_id}/{report_id}.pdf"


def _upload_pdf(user_id: str, report_id: str, local_path: Path) -> None:
    """Upload the checked PDF into Supabase Storage. Falls back to a local
    directory when Supabase isn't configured (local dev only)."""
    client = get_client()
    if client is not None:
        try:
            with local_path.open("rb") as f:
                client.storage.from_(DOCUMENTS_BUCKET).upload(
                    _storage_path(user_id, report_id),
                    f.read(),
                    file_options={"content-type": "application/pdf", "upsert": "true"},
                )
            return
        except Exception:
            logger.exception(
                "Failed to upload PDF to Supabase Storage for report_id=%s", report_id
            )
    try:
        shutil.copy(str(local_path), str(LOCAL_PDF_FALLBACK_DIR / f"{report_id}.pdf"))
    except OSError:
        logger.exception("Failed to write local PDF fallback for report_id=%s", report_id)


def _delete_pdf(user_id: str | None, report_id: str) -> None:
    client = get_client()
    if client is not None and user_id is not None:
        try:
            client.storage.from_(DOCUMENTS_BUCKET).remove([_storage_path(user_id, report_id)])
        except Exception:
            logger.exception(
                "Failed to delete PDF from Supabase Storage for report_id=%s", report_id
            )
    fallback_path = LOCAL_PDF_FALLBACK_DIR / f"{report_id}.pdf"
    fallback_path.unlink(missing_ok=True)


STUDENT_VERIFICATION_BUCKET = "student-verification"


def _purge_user_storage(client, user_id: str) -> None:
    """Best-effort delete of every Storage object under `{user_id}/` in both
    per-user buckets. `documents`/`student-verification` objects aren't
    referenced by any SQL foreign key, so deleting the `auth.users` row (see
    `delete_account` / `force_delete_user`) never cascades to them on its
    own — this is the only cleanup path for "along with all their data."
    Failures are logged, not raised: an account deletion the caller already
    committed to should not be left half-done because Storage listing/remove
    hit a transient error.
    """
    for bucket in (DOCUMENTS_BUCKET, STUDENT_VERIFICATION_BUCKET):
        try:
            objects = client.storage.from_(bucket).list(user_id)
            paths = [f"{user_id}/{obj['name']}" for obj in (objects or [])]
            if paths:
                client.storage.from_(bucket).remove(paths)
        except Exception:
            logger.exception(
                "Failed to purge Storage objects for user_id=%s in bucket=%s", user_id, bucket
            )


# Which of the user's three independent balances to spend on a check:
# their plan's monthly allowance, or one of the two purchased credit packs.
BalanceSource = Literal["plan", "standard", "premium"]


class TextCheckRequest(BaseModel):
    text: str = Field(min_length=30, max_length=100_000)
    balance_source: BalanceSource

class StoredFileCheckRequest(BaseModel):
    # Where the browser uploaded the file in the documents bucket:
    # "{user_id}/uploads/{name}.pdf" (see _check_upload_path).
    storage_path: str = Field(..., min_length=1, max_length=500)
    file_name: str = Field(..., min_length=1, max_length=255)
    balance_source: BalanceSource


class UnlockDocumentRequest(BaseModel):
    tier: Literal["student", "professional"]


class RewriteRequest(BaseModel):
    input_sentence: str
    source_sentence: str
    # The report the passage belongs to: the rewrite is then checked against
    # its sources and regenerated while it still overlaps one.
    report_id: Optional[str] = Field(None, max_length=100)


class QuickCheckSource(BaseModel):
    title: str = Field("", max_length=1000)
    text: str = Field("", max_length=5000)


class QuickCheckRequest(BaseModel):
    text: str = Field(..., max_length=MAX_QUICK_CHECK_CHARS)
    # The matched source sentences the page shows — only used when the
    # backend has no copy of this report (see quick_check.corpus_from_sources).
    sources: list[QuickCheckSource] = Field(default_factory=list, max_length=500)


# Same overall size cap as /api/check/text.
MAX_RECHECK_CHARS = 100_000


class RecheckBlock(BaseModel):
    # The editor's data-block-id, i.e. the passage id from the last check.
    block_id: str = Field(..., max_length=100)
    text: str = Field("", max_length=MAX_RECHECK_CHARS)


class RecheckQuoteRequest(BaseModel):
    blocks: list[RecheckBlock] = Field(..., min_length=1, max_length=5000)

    def joined_text(self) -> str:
        text = "\n\n".join(b.text.strip() for b in self.blocks if b.text.strip())
        if len(text) > MAX_RECHECK_CHARS:
            raise HTTPException(status_code=413, detail="This document is too long to re-check.")
        return text


class RecheckRequest(RecheckQuoteRequest):
    # The document_versions row saved for this text just before re-checking.
    version_id: UUID | None = None
    # The cost the user confirmed from the quote; refused (409) if it changed.
    expected_cost: Literal["free", "check"]
    balance_source: BalanceSource | None = None


class ReferenceModel(BaseModel):
    """One bibliography entry. `id` is what keeps a reference stable
    across renumbering — the frontend should pass the match's
    `source_paper_id` as the id when citing a matched source."""
    id: str | None = None
    source_paper_id: str | None = None
    title: str | None = None
    authors: str | list[str] | None = None
    year: int | str | None = None
    url: str | None = None
    pdf_url: str | None = None


class CiteRequest(BaseModel):
    text: str = Field(max_length=1_000_000)
    references: list[ReferenceModel] = Field(default_factory=list, max_length=500)
    insert_at: int = Field(ge=0)
    source: ReferenceModel
    heading: str = DEFAULT_REFERENCE_HEADING


@app.get("/api/health")
def health():
    # active_jobs: checks in progress, so scripts/deploy_watch.sh can wait for
    # them to finish before restarting.
    return {"status": "ok", "service": "plagiarism-checker", "active_jobs": active_count()}


def run_marker_preview_job(*, report_id: str, pdf_path: Path) -> None:
    """
    Best-effort and fully separate from run_pdf_job: converts the
    just-checked PDF into an HTML/docx preview via marker-pdf
    (marker_preview.py), for the Report page's Original view
    (PlagiarismPdfViewer's replacement). Runs in its own daemon thread,
    started only after the real check has already succeeded, and never
    raises past this function — a failure here only ever means "no nicer
    preview today"; it must never fail or retry the underlying check.
    """
    init_marker_preview(report_id)
    work_dir = MARKER_PREVIEW_DIR / report_id
    try:
        if marker_preview.uses_gpu():
            # marker-pdf loads its own models onto the GPU, so it takes a slot
            # like a check, and idle check models make room for it.
            with gpu_slot():
                gpu_models.free_idle()
                result = marker_preview.build_marker_preview(pdf_path, work_dir)
        else:
            result = marker_preview.build_marker_preview(pdf_path, work_dir)
        mark_marker_preview_ready(
            report_id, html=result["html"], docx_local_path=str(result["docx_path"])
        )
    except marker_preview.MarkerUnavailable as exc:
        logger.warning("marker-pdf preview unavailable for report_id=%s: %s", report_id, exc)
        mark_marker_preview_failed(report_id, error=str(exc))
    except Exception as exc:
        logger.exception("marker-pdf preview failed unexpectedly for report_id=%s", report_id)
        mark_marker_preview_failed(report_id, error=str(exc))
    finally:
        try:
            pdf_path.unlink(missing_ok=True)
        except OSError:
            pass


# Shown to users when a check fails for a reason they can't act on. The
# traceback goes to the log (traceback.print_exc / logger.exception), never
# to the page: raw errors carry server paths and library internals.
GENERIC_CHECK_ERROR = "Something went wrong on our side while checking this document. You weren't charged. Please try again."


def user_error_message(exc: Exception) -> str:
    """The job error a user sees. ValueError is what our own code raises with
    a message meant for the user (e.g. "The document is empty."); anything
    else is an internal failure and gets the generic message."""
    if type(exc) is ValueError and str(exc):
        return str(exc)
    return GENERIC_CHECK_ERROR


def _upload_docx_rendering(user_id: str, report_id: str, docx_path: Path) -> None:
    """Store a PDF rendering of a checked .docx where a PDF upload's original
    goes, when LibreOffice is available. Never raises."""
    from docx_to_pdf import convert_docx_to_pdf

    work_dir = Path(tempfile.mkdtemp(prefix="docx-pdf-"))
    try:
        converted = convert_docx_to_pdf(docx_path, work_dir)
        if converted is not None:
            _upload_pdf(user_id, report_id, converted)
    except Exception:
        logger.exception("Could not store a PDF rendering for report_id=%s", report_id)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def run_pdf_job(*, job_id: str, pdf_path: str, original_name: str, user_id: str | None,
                 balance_source: BalanceSource, input_type: Literal["pdf", "docx"] = "pdf") -> None:
    """
    Runs either extraction pipeline depending on `input_type`. Named
    run_pdf_job (not renamed to something generic) because it is still
    reached exclusively via the `/api/check/pdf` endpoint below, which now
    accepts both extensions — see create_pdf_check().

    The original PDF is stored (`_upload_pdf`) for the Report page's
    Original view. A .docx is first rendered to PDF with LibreOffice
    (docx_to_pdf.py); without LibreOffice it gets no Original view and the
    Document view is the only view, rather than the wrong bytes being
    stored under a `.pdf`-suffixed Storage key.
    """
    callback = make_progress_callback(job_id)

    try:
        with gpu_slot(on_wait=make_queue_callback(job_id)):
            update_job(job_id, status="processing", progress=1,
                       current_step="starting",
                       message=f"Starting {'DOCX' if input_type == 'docx' else 'PDF'} analysis")

            if input_type == "docx":
                report = check_docx_plagiarism(docx_path=pdf_path, progress_callback=callback)
            else:
                report = check_pdf_plagiarism(pdf_path=pdf_path, progress_callback=callback)

        report_id = save_report(report, input_type=input_type, input_name=original_name, user_id=user_id,
                                unlocked_tier=credit_tier(balance_source))

        if user_id is not None and input_type == "pdf":
            _upload_pdf(user_id, report_id, Path(pdf_path))
            try:
                marker_input_copy = MARKER_PREVIEW_DIR / report_id / "input.pdf"
                marker_input_copy.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy(pdf_path, marker_input_copy)
                threading.Thread(
                    target=run_marker_preview_job,
                    kwargs={"report_id": report_id, "pdf_path": marker_input_copy},
                    daemon=True,
                ).start()
            except Exception:
                logger.exception(
                    "Failed to start marker-pdf preview job for report_id=%s", report_id
                )

        if user_id is not None and input_type == "docx":
            _upload_docx_rendering(user_id, report_id, Path(pdf_path))

        # Charge before reporting "completed", so a client that re-reads the
        # balances as soon as the job settles already sees the check spent.
        if user_id is not None:
            record_check_used(user_id, balance_source)
        update_job(job_id, status="completed", progress=100,
                   current_step="completed", message="Analysis complete",
                   report_id=report_id)
    except Exception as exc:
        traceback.print_exc()
        update_job(job_id, status="failed", current_step="failed",
                   message=f"{'DOCX' if input_type == 'docx' else 'PDF'} analysis failed", error=user_error_message(exc))
    finally:
        try:
            Path(pdf_path).unlink(missing_ok=True)
        except OSError:
            pass
        try:
            Path(pdf_path).parent.rmdir()
        except OSError:
            pass


def run_text_job(*, job_id: str, user_text: str, user_id: str | None,
                  balance_source: BalanceSource) -> None:
    callback = make_progress_callback(job_id)
    try:
        with gpu_slot(on_wait=make_queue_callback(job_id)):
            update_job(job_id, status="processing", progress=1,
                       current_step="starting", message="Starting text analysis")
            report = check_text_plagiarism(user_text=user_text, progress_callback=callback)
        report_id = save_report(report, input_type="text", input_name="Pasted text", user_id=user_id,
                                unlocked_tier=credit_tier(balance_source))
        # Charge before reporting "completed", so a client that re-reads the
        # balances as soon as the job settles already sees the check spent.
        if user_id is not None:
            record_check_used(user_id, balance_source)
        update_job(job_id, status="completed", progress=100,
                   current_step="completed", message="Analysis complete",
                   report_id=report_id)
    except Exception as exc:
        traceback.print_exc()
        update_job(job_id, status="failed", current_step="failed",
                   message="Text analysis failed", error=user_error_message(exc))


@app.post("/api/check/pdf", status_code=202)
@limiter.limit(RATE_LIMIT_CHECK_PDF)
async def create_pdf_check(request: Request, file: UploadFile = File(...),
                            balance_source: BalanceSource = Form(...),
                            user: AuthedUser = Depends(verify_supabase_jwt)):
    """
    Despite the path, this now accepts both .pdf and .docx — kept as one
    endpoint (rather than adding /api/check/docx) because the web app's
    submitPdfCheck() (apps/web/src/lib/api.ts) already just POSTs an
    arbitrary File here, so a docx upload needs zero frontend wiring on
    this side. What still gates docx end-to-end is the Upload screen's own
    client-side `file.type === "application/pdf"` check (Upload/index.tsx)
    — out of scope here (owned by a different in-flight change), so a docx
    reaches this endpoint only via a direct API call today, not the
    current Upload UI.
    """
    filename = file.filename or "uploaded.pdf"
    lower_name = filename.lower()
    if lower_name.endswith(".pdf"):
        input_type: Literal["pdf", "docx"] = "pdf"
        suffix = ".pdf"
    elif lower_name.endswith(".docx"):
        input_type = "docx"
        suffix = ".docx"
    else:
        raise HTTPException(status_code=400, detail="Only PDF or DOCX files are supported.")

    ensure_quota_available(user.user_id, balance_source)

    job_id = create_job(input_type=input_type, input_name=filename, user_id=user.user_id)
    temp_dir = Path(tempfile.mkdtemp(prefix=f"{job_id}_"))
    upload_path = temp_dir / f"input{suffix}"

    try:
        with upload_path.open("wb") as output:
            shutil.copyfileobj(file.file, output)
    finally:
        await file.close()

    if upload_path.stat().st_size == 0:
        upload_path.unlink(missing_ok=True)
        temp_dir.rmdir()
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    threading.Thread(
        target=run_pdf_job,
        kwargs={"job_id": job_id, "pdf_path": str(upload_path), "original_name": filename,
                "user_id": user.user_id, "balance_source": balance_source, "input_type": input_type},
        daemon=True,
    ).start()

    return {"job_id": job_id, "status": "queued", "input_type": input_type}


# Uploads the browser puts in the documents bucket for a check, under the
# user's own folder (storage policy documents_bucket_owner_write already
# limits writes to "{auth.uid()}/..."). Removed again once the check ends:
# a checked PDF is kept at _storage_path() as before.
UPLOADS_FOLDER = "uploads"


def _check_upload_path(storage_path: str, user_id: str) -> Literal["pdf", "docx"]:
    """The file type of a browser upload, or 400 unless the path is a PDF or
    DOCX inside this user's own uploads folder."""
    parts = storage_path.split("/")
    name = parts[-1].lower() if parts else ""
    if (
        len(parts) != 3
        or parts[0] != user_id
        or parts[1] != UPLOADS_FOLDER
        or not parts[2]
        or ".." in storage_path
        or "\\" in storage_path
    ):
        raise HTTPException(status_code=400, detail="That file isn't in your uploads.")
    if name.endswith(".pdf"):
        return "pdf"
    if name.endswith(".docx"):
        return "docx"
    raise HTTPException(status_code=400, detail="Only PDF or DOCX files are supported.")


def run_stored_file_job(*, job_id: str, storage_path: str, original_name: str, user_id: str,
                        balance_source: BalanceSource, input_type: Literal["pdf", "docx"]) -> None:
    """Fetch the browser's upload from Supabase Storage, then check it exactly
    like an uploaded file (run_pdf_job). The upload is removed afterwards,
    whatever the outcome."""
    client = get_client()
    try:
        update_job(job_id, status="processing", progress=1, current_step="receiving_file",
                   message="Receiving your file")
        data = client.storage.from_(DOCUMENTS_BUCKET).download(storage_path) if client else None
        if not data:
            raise ValueError("The uploaded file is missing or empty. Please upload it again.")
        temp_dir = Path(tempfile.mkdtemp(prefix=f"{job_id}_"))
        local_path = temp_dir / f"input.{input_type}"
        local_path.write_bytes(data)
    except Exception as exc:
        logger.exception("Could not fetch upload %s for job %s", storage_path, job_id)
        update_job(job_id, status="failed", current_step="failed",
                   message="Couldn't receive your file", error=user_error_message(exc))
        _remove_upload(storage_path)
        return

    try:
        run_pdf_job(job_id=job_id, pdf_path=str(local_path), original_name=original_name,
                    user_id=user_id, balance_source=balance_source, input_type=input_type)
    finally:
        _remove_upload(storage_path)


def _remove_upload(storage_path: str) -> None:
    client = get_client()
    if client is None:
        return
    try:
        client.storage.from_(DOCUMENTS_BUCKET).remove([storage_path])
    except Exception:
        logger.exception("Could not remove upload %s", storage_path)


@app.post("/api/check/stored-file", status_code=202)
@limiter.limit(RATE_LIMIT_CHECK_PDF)
def create_stored_file_check(request: Request, body: StoredFileCheckRequest,
                             user: AuthedUser = Depends(verify_supabase_jwt)):
    """
    Check a PDF/DOCX the browser already uploaded to Supabase Storage. The
    file never passes through api.etymos.site: for some networks Cloudflare
    routes that host far away, where large uploads crawl and get cut off,
    while Supabase Storage stays close. This request is a few hundred bytes.
    """
    input_type = _check_upload_path(body.storage_path, user.user_id)
    if get_client() is None:
        raise HTTPException(status_code=503, detail="File storage isn't available right now.")
    ensure_quota_available(user.user_id, body.balance_source)

    job_id = create_job(input_type=input_type, input_name=body.file_name, user_id=user.user_id)
    threading.Thread(
        target=run_stored_file_job,
        kwargs={"job_id": job_id, "storage_path": body.storage_path, "original_name": body.file_name,
                "user_id": user.user_id, "balance_source": body.balance_source, "input_type": input_type},
        daemon=True,
    ).start()
    return {"job_id": job_id, "status": "queued", "input_type": input_type}


@app.post("/api/check/text", status_code=202)
@limiter.limit(RATE_LIMIT_CHECK_TEXT)
def create_text_check(request: Request, body: TextCheckRequest,
                       user: AuthedUser = Depends(verify_supabase_jwt)):
    ensure_quota_available(user.user_id, body.balance_source)

    job_id = create_job(input_type="text", input_name="Pasted text", user_id=user.user_id)
    threading.Thread(
        target=run_text_job,
        kwargs={"job_id": job_id, "user_text": body.text.strip(), "user_id": user.user_id,
                "balance_source": body.balance_source},
        daemon=True,
    ).start()
    return {"job_id": job_id, "status": "queued", "input_type": "text"}


@app.get("/api/jobs/{job_id}")
def read_job(job_id: str, user: AuthedUser = Depends(verify_supabase_jwt)):
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found.")
    require_owner_or_admin(job.get("user_id"), user)
    return job


@app.post("/api/documents/{document_id}/unlock")
def unlock_document(document_id: UUID, body: UnlockDocumentRequest,
                    user: AuthedUser = Depends(verify_supabase_jwt)):
    """Spend one credit to give this document a higher tier's features (the
    paywall's "use a credit on this document"). Ownership is checked inside
    the SQL function, which only matches the caller's own documents."""
    result = unlock_document_with_credit(user.user_id, str(document_id), body.tier)
    set_cached_unlocked_tier(str(document_id), result.get("unlocked_tier"))
    return result


@app.get("/api/reports/{report_id}")
def read_report(report_id: str, user: AuthedUser = Depends(verify_supabase_jwt)):
    report = get_report(report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Report not found.")
    require_owner_or_admin(report.get("user_id"), user)
    return report


@app.get("/api/reports/{report_id}/source-pdf")
def get_source_pdf(report_id: str, user: AuthedUser = Depends(verify_supabase_jwt)):
    report = get_report(report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Report not found.")
    require_owner_or_admin(report.get("user_id"), user)

    owner_id = report.get("user_id")
    client = get_client()
    if client is not None and owner_id is not None:
        try:
            signed = client.storage.from_(DOCUMENTS_BUCKET).create_signed_url(
                _storage_path(owner_id, report_id), 60
            )
            signed_url = (signed or {}).get("signedURL") or (signed or {}).get("signed_url")
            if signed_url:
                return RedirectResponse(url=signed_url)
        except Exception:
            logger.exception(
                "Failed to create signed URL for report_id=%s; falling back to local disk.",
                report_id,
            )

    fallback_path = LOCAL_PDF_FALLBACK_DIR / f"{report_id}.pdf"
    if not fallback_path.exists():
        raise HTTPException(status_code=404, detail="Không tìm thấy file PDF gốc cho báo cáo này.")
    return FileResponse(path=fallback_path, media_type="application/pdf", filename=f"{report_id}.pdf")


@app.get("/api/reports/{report_id}/marker-preview")
def read_marker_preview(report_id: str, user: AuthedUser = Depends(verify_supabase_jwt)):
    """
    Status/result of the marker-pdf conversion started by run_pdf_job right
    after this report's check completed (see run_marker_preview_job above).
    The frontend polls this the way pollJob() polls /api/jobs/{id} — see
    apps/web/src/components/MarkerDocumentViewer.tsx.

    `{"status": "unavailable", ...}` (not a 404) covers every case where no
    preview will ever show up: a .docx-sourced report (no source PDF to
    convert), a report checked before this feature shipped, or a process
    restart that dropped the in-memory entry — the frontend treats all of
    these the same way, as "no preview today", not an error to retry.
    """
    report = get_report(report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Report not found.")
    require_owner_or_admin(report.get("user_id"), user)

    preview = get_marker_preview(report_id)
    if preview is None:
        return {"status": "unavailable", "html": None, "docx_ready": False, "error": None}
    return preview


@app.get("/api/reports/{report_id}/marker-preview/docx")
def download_marker_preview_docx(report_id: str, user: AuthedUser = Depends(verify_supabase_jwt)):
    report = get_report(report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Report not found.")
    require_owner_or_admin(report.get("user_id"), user)

    docx_path = has_docx_ready(report_id)
    if not docx_path or not Path(docx_path).exists():
        raise HTTPException(status_code=404, detail="The .docx preview isn't ready yet.")
    return FileResponse(
        path=docx_path,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename=f"{report_id}.docx",
    )


@app.post("/api/ai/rewrite")
@limiter.limit(RATE_LIMIT_AI_REWRITE)
def rewrite_text_with_ai(request: Request, body: RewriteRequest,
                          user: AuthedUser = Depends(verify_supabase_jwt)):
    """
    AI Rewrite. Runs on the local Qwen2.5 model by default; admins can
    switch it to the Gemini API from the admin portal via the
    `gemini_ai_rewrite` feature flag (same mechanism as the existing
    `gemini_metadata_extraction` toggle). If the selected provider fails,
    the other one is tried before giving up.

    Response is additive: `success` and `rewritten_text` are unchanged;
    `provider` / `model` / `fallback_used` are new.
    """
    check = None
    if body.report_id:
        report = get_report(body.report_id)
        if report is not None:
            require_owner_or_admin(report.get("user_id"), user)
            # As in quick_check_passage: the local JSON has the source_paper_ids.
            local = get_local_report_file(body.report_id)
            if local is not None and local.get("matches"):
                report = local
            report_id = body.report_id

            def check(text: str) -> dict:
                return quick_check_report_passage(report_id, report, text)

    try:
        result = rewrite_sentence(
            input_sentence=body.input_sentence,
            source_sentence=body.source_sentence,
            check=check,
        )
    except RewriteUnavailable as exc:
        logger.warning("AI rewrite unavailable: %s", exc)
        raise HTTPException(
            status_code=503,
            detail="AI rewrite is unavailable right now. Please try again shortly.",
        )
    except Exception:
        logger.exception("AI rewrite failed unexpectedly.")
        raise HTTPException(status_code=500, detail="AI rewrite failed.")

    return {
        "success": True,
        "rewritten_text": result["rewritten_text"],
        "provider": result["provider"],
        "model": result["model"],
        "fallback_used": result["fallback_used"],
        # Quick-check verdict of the returned rewrite, when it was checked.
        "check": result.get("check"),
    }


@app.post("/api/reports/{report_id}/quick-check")
@limiter.limit(RATE_LIMIT_QUICK_CHECK)
def quick_check_passage(request: Request, report_id: str, body: QuickCheckRequest,
                        user: AuthedUser = Depends(verify_supabase_jwt)):
    """
    Quick check ("check nhanh") of one rewritten / hand-edited passage
    against the sources this report already found (quick_check.py). No
    search and no downloads, and it does not use a check from the quota.
    A clean result only means "no overlap with this report's sources";
    finding new sources takes a full re-check.
    """
    report = get_report(report_id)
    if report is None:
        if not body.sources:
            raise HTTPException(status_code=404, detail="Report not found.")
        # Nothing stored server-side for this id: compare with the source
        # sentences the caller sent (its own data, so no ownership to check).
        try:
            return check_passage(body.text, corpus_from_sources([s.model_dump() for s in body.sources]))
        except Exception:
            logger.exception("Quick check (client sources) failed for report_id=%s", report_id)
            raise HTTPException(status_code=500, detail="Quick check failed.")
    require_owner_or_admin(report.get("user_id"), user)

    # The local JSON still has each match's source_paper_id (the Supabase
    # copy does not), which is what finds the source chunk files.
    local = get_local_report_file(report_id)
    if local is not None and local.get("matches"):
        report = local

    try:
        result = quick_check_report_passage(report_id, report, body.text)
    except Exception:
        logger.exception("Quick check failed for report_id=%s", report_id)
        raise HTTPException(status_code=500, detail="Quick check failed.")
    return result


@app.post("/api/reports/{report_id}/quick-check/warm", status_code=202)
@limiter.limit(RATE_LIMIT_QUICK_CHECK)
def warm_quick_check(request: Request, report_id: str,
                     user: AuthedUser = Depends(verify_supabase_jwt)):
    """
    Called when the reader opens the Edit view: loads this report's source
    sentences and the embedding model in the background, so the first quick
    check answers in well under a second instead of waiting ~10 s for the
    model. Returns immediately.
    """
    report = get_report(report_id)
    if report is None:
        return {"status": "skipped"}
    require_owner_or_admin(report.get("user_id"), user)
    local = get_local_report_file(report_id)
    if local is not None and local.get("matches"):
        report = local
    threading.Thread(target=warm_up_quick_check, args=(report_id, report), daemon=True).start()
    return {"status": "warming"}


@app.post("/api/reports/{report_id}/recheck/quote")
@limiter.limit(RATE_LIMIT_RECHECK_QUOTE)
def quote_report_recheck(request: Request, report_id: str, body: RecheckQuoteRequest,
                         user: AuthedUser = Depends(verify_supabase_jwt)):
    """
    What "Save & re-check" would cost for the editor's current text: free
    (within the tier's limits) or one check. Read-only; the re-check itself
    recomputes this and refuses if it no longer matches (recheck_quota.py).
    """
    report = get_report(report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Report not found.")
    require_owner_or_admin(report.get("user_id"), user)
    return quote_recheck(report_id, report, body.joined_text())


# One running re-check per document. Held from the request until the job
# ends, so the free re-check count a quote is based on can't change under it.
_RECHECKS_RUNNING: set[str] = set()
_RECHECKS_LOCK = threading.Lock()


def _previous_check(report_id: str, report: dict, passages: dict[str, dict]) -> dict:
    """The current report in full: the local JSON (re-checks and restores
    rewrite it), else the stored check the document shows now, else the
    Supabase copy rebuilt from its passages."""
    from recheck import full_report

    local = get_local_report_file(report_id)
    if local is not None and local.get("matches") is not None:
        return local
    return current_check_result(report_id) or full_report(report, passages)


def _keep_upload_result(report_id: str, previous: dict, previous_text: str) -> None:
    """
    Before a document's first re-check replaces its upload result, store that
    result as a document_checks row, so Version History can always restore it.
    Raises RecheckStoreError when it can't be stored: the re-check must not
    run then, or the upload result would be lost for good.
    """
    from recheck import ai_score

    if has_stored_result(report_id):
        return  # The current result is already a stored check.
    if not previous.get("input_text"):
        raise RecheckStoreError("Couldn't save the current version, so nothing was changed.")
    try:
        insert_check(
            document_id=report_id, version_id=None, kind="upload", balance_source=None,
            changed_ratio=0.0, similarity_score=float(previous.get("overall_score") or 0.0),
            baseline_text=previous_text or previous["input_text"], result=previous,
            ai_score=ai_score(previous) if previous.get("ai_detection") else None,
        )
    except RecheckStoreError as exc:
        raise RecheckStoreError("Couldn't save the current version, so nothing was changed.") from exc


def run_recheck_job(job_id: str, report_id: str, report: dict, blocks: list[dict], text: str,
                    quote: dict, version_id: str | None, user_id: str,
                    balance_source: str | None) -> None:
    callback = make_progress_callback(job_id)
    paid = quote["cost"] == "check"
    try:
        from recheck import ai_score, run_recheck

        passages = fetch_passages(report_id)
        previous = _previous_check(report_id, report, passages)
        # The text this re-check replaces, read before the passages change.
        previous_text = original_text(report_id, previous)
        _keep_upload_result(report_id, previous, previous_text)
        with gpu_slot(on_wait=make_queue_callback(job_id)):
            update_job(job_id, status="processing", progress=1,
                       current_step="starting", message="Starting re-check")
            result = run_recheck(previous, blocks, passages, progress_callback=callback)

        check_id = insert_check(
            document_id=report_id, version_id=version_id,
            kind="paid_recheck" if paid else "free_recheck",
            balance_source=balance_source if paid else None,
            changed_ratio=quote["changed_ratio"], similarity_score=result["overall_score"],
            baseline_text=text, result=result,
            ai_score=ai_score(result),
            previous_score=previous.get("overall_score", report.get("overall_score")),
            previous_ai_score=ai_score(previous) if previous.get("ai_detection") else ai_score(report),
            previous_text=previous_text,
        )

        # A credit unlocks its tier, as on a new check, but never lowers one.
        new_tier = credit_tier(balance_source) if paid and balance_source else None
        current_tier = previous.get("unlocked_tier") or report.get("unlocked_tier")
        if new_tier and TIER_RANK.get(current_tier or "free", 0) >= TIER_RANK[new_tier]:
            new_tier = None
        try:
            replace_report(report_id, result,
                           {**report, **{k: previous.get(k) for k in ("input", "created_at") if previous.get(k)}},
                           unlocked_tier=new_tier, check_id=check_id)
        except ReportStoreError as exc:
            raise RecheckStoreError("Couldn't apply the re-check. It's saved in Version History: "
                                    "restore it from there, or try again.") from exc
        forget_quick_check_corpus(report_id)

        if paid and balance_source:
            record_check_used(user_id, balance_source)
        update_job(job_id, status="completed", progress=100, current_step="completed",
                   message="Re-check complete", report_id=report_id)
    except RecheckStoreError as exc:
        update_job(job_id, status="failed", current_step="failed",
                   message="Re-check failed", error=str(exc))
    except Exception as exc:
        traceback.print_exc()
        update_job(job_id, status="failed", current_step="failed",
                   message="Re-check failed", error=user_error_message(exc))
    finally:
        with _RECHECKS_LOCK:
            _RECHECKS_RUNNING.discard(report_id)


@app.post("/api/reports/{report_id}/recheck", status_code=202)
@limiter.limit(RATE_LIMIT_RECHECK)
def recheck_report(request: Request, report_id: str, body: RecheckRequest,
                   user: AuthedUser = Depends(verify_supabase_jwt)):
    """
    Save & re-check: run the full check on only the paragraphs that changed
    (recheck.py) and replace this report with the result, under the same id.
    Free within the tier's limits, otherwise one check from `balance_source`,
    charged only after success. The server prices it again here and refuses
    with 409 if that no longer matches what the user confirmed.
    """
    report = get_report(report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Report not found.")
    require_owner_or_admin(report.get("user_id"), user)
    text = body.joined_text()

    version_id = str(body.version_id) if body.version_id else None
    if version_id and not version_belongs_to(version_id, report_id):
        raise HTTPException(status_code=400, detail="Save this version to the server before re-checking it.")

    with _RECHECKS_LOCK:
        if report_id in _RECHECKS_RUNNING:
            raise HTTPException(status_code=409, detail={"code": "already_running",
                                                         "message": "This document is already being re-checked."})
        _RECHECKS_RUNNING.add(report_id)
    try:
        quote = quote_recheck(report_id, report, text)
        if quote["cost"] != body.expected_cost:
            raise HTTPException(status_code=409, detail={"code": "cost_changed", "quote": quote,
                                                         "message": "The cost of this re-check changed. Please review it again."})
        if quote["cost"] == "check":
            if body.balance_source is None:
                raise HTTPException(status_code=422, detail="Choose which balance this re-check should use.")
            ensure_quota_available(user.user_id, body.balance_source)

        job_id = create_job(input_type="recheck", input_name=(report.get("input") or {}).get("name") or "Re-check",
                            user_id=user.user_id)
        threading.Thread(
            target=run_recheck_job,
            kwargs={"job_id": job_id, "report_id": report_id, "report": report,
                    "blocks": [b.model_dump() for b in body.blocks], "text": text, "quote": quote,
                    "version_id": version_id, "user_id": user.user_id,
                    "balance_source": body.balance_source if quote["cost"] == "check" else None},
            daemon=True,
        ).start()
    except BaseException:
        with _RECHECKS_LOCK:
            _RECHECKS_RUNNING.discard(report_id)
        raise
    return {"job_id": job_id, "status": "queued", "quote": quote}



@app.post("/api/reports/{report_id}/checks/{check_id}/restore")
@limiter.limit(RATE_LIMIT_RECHECK_QUOTE)
def restore_report_check(request: Request, report_id: str, check_id: UUID,
                         user: AuthedUser = Depends(verify_supabase_jwt)):
    """
    Version History: make an earlier result (a re-check's, or the upload's)
    the current report again (its text, matches and score). Nothing is re-run and nothing is
    charged, and the re-check history is unchanged, so the free allowance and
    its baseline stay as they were.
    """
    report = get_report(report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Report not found.")
    require_owner_or_admin(report.get("user_id"), user)
    with _RECHECKS_LOCK:
        if report_id in _RECHECKS_RUNNING:
            raise HTTPException(status_code=409, detail={"code": "already_running",
                                                         "message": "This document is being re-checked."})
    try:
        result = fetch_check_result(str(check_id), report_id)
    except RecheckStoreError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    if result is None:
        raise HTTPException(status_code=404, detail="Check not found.")
    if not (result.get("input_text") and (result.get("document") or {}).get("blocks")):
        # Restoring it would leave the document with no paragraphs.
        raise HTTPException(status_code=409, detail="This version's text wasn't stored, so it can't be restored.")
    # Only the check's own report fields: never let a stored result change
    # who owns the document or its unlocked tier.
    result = {k: v for k, v in result.items() if k not in ("user_id", "unlocked_tier", "report_id", "input")}
    try:
        replace_report(report_id, result, report, check_id=str(check_id))
    except ReportStoreError:
        raise HTTPException(status_code=503, detail="Couldn't restore this version. Please try again.")
    forget_quick_check_corpus(report_id)
    return {"status": "restored", "overall_score": result.get("overall_score")}

@app.post("/api/documents/cite")
@limiter.limit(RATE_LIMIT_CITE)
def cite_source(request: Request, body: CiteRequest,
                 user: AuthedUser = Depends(verify_supabase_jwt)):
    """
    Cite a source: insert an inline `[n]` marker at the caret, append the
    source to the document's reference section, and renumber every
    existing citation so markers read 1, 2, 3… in order of appearance.

    Stateless by design — the client owns the document text and the
    reference list, and this endpoint returns the edited document plus an
    `offset_map` for rebasing any highlight offsets it is holding. That
    keeps citing free of report-storage migrations.
    """
    try:
        result = add_citation(
            text=body.text,
            references=[r.model_dump() for r in body.references],
            insert_at=body.insert_at,
            source=body.source.model_dump(),
            heading=body.heading,
        )
    except Exception:
        logger.exception("Failed to add citation.")
        raise HTTPException(status_code=400, detail="Could not add this citation.")

    return result


@app.get("/api/reports")
def read_reports(user: AuthedUser = Depends(verify_supabase_jwt)):
    return {"items": list_reports(user_id=user.user_id, is_admin=user.is_admin)}


@app.delete("/api/reports/{report_id}")
def remove_report(report_id: str, user: AuthedUser = Depends(verify_supabase_jwt)):
    report = get_report(report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Report not found.")
    require_owner_or_admin(report.get("user_id"), user)
    if not delete_report(report_id):
        raise HTTPException(status_code=404, detail="Report not found.")
    _delete_pdf(report.get("user_id"), report_id)
    shutil.rmtree(MARKER_PREVIEW_DIR / report_id, ignore_errors=True)
    return {"deleted": True, "report_id": report_id}


RATE_LIMIT_PASSWORD_NOTICE = os.getenv("RATE_LIMIT_PASSWORD_NOTICE", "5/hour")


@app.post("/api/account/password-changed")
@limiter.limit(RATE_LIMIT_PASSWORD_NOTICE)
def password_changed(request: Request, background: BackgroundTasks, user: AuthedUser = Depends(verify_supabase_jwt)):
    """Called by the web app right after supabase.auth.updateUser({password})
    succeeds, so the account's own address gets a "your password was
    changed" email. Supabase doesn't tell the backend about password
    changes. The mail only ever goes to the caller's own login email, and
    the rate limit stops it being used to flood that inbox."""
    background.add_task(notifications.notify_password_changed, user.user_id, user.email)
    return {"ok": True}


@app.delete("/api/account")
def delete_account(background: BackgroundTasks, user: AuthedUser = Depends(verify_supabase_jwt)):
    """
    Self-service account deletion (PLAN.md decision: "user deletes their
    own account from AccountProfile, backend strictly checks the caller's
    JWT matches the target user_id"). This endpoint takes NO id parameter
    from the client at all — the target is always
    `verify_supabase_jwt`'s own verified user_id — so there is no
    cross-account deletion path to get wrong, by construction. No admin
    override for this endpoint.

    Deletes the auth.users row via the service-role client; this cascades
    to `profiles` (and everything that references it, e.g. `documents`)
    via `profiles.id references auth.users(id) on delete cascade`
    (supabase/migrations/20260715120000_profiles.sql). Irreversible.
    """
    client = get_client()
    if client is None:
        raise HTTPException(status_code=500, detail="Account deletion is not configured on this server.")
    _purge_user_storage(client, user.user_id)
    try:
        client.auth.admin.delete_user(user.user_id)
    except Exception:
        logger.exception("Failed to delete account for user_id=%s", user.user_id)
        raise HTTPException(status_code=500, detail="Failed to delete account.")
    background.add_task(notifications.notify_account_deleted, user.email)
    return {"deleted": True, "user_id": user.user_id}


@app.delete("/api/admin/users/{target_user_id}")
def force_delete_user(target_user_id: str, background: BackgroundTasks, user: AuthedUser = Depends(verify_supabase_jwt)):
    """
    Admin-triggered account deletion that skips the user-confirmation dialog
    entirely (CHANGES_I_WANT.md Admin Portal #3: "force delete mode ... will
    delete without user consent"). The non-force path deliberately reuses
    `DELETE /api/account` instead of a separate endpoint: the admin side
    only ever *requests* deletion (setting profiles.deletion_requested_at/by
    via a direct client update — see apps/admin/src/lib/supabaseQueries.ts),
    and the user's own browser is the one that calls `DELETE /api/account`
    to actually confirm and execute it, using their own JWT. This endpoint
    is the only path that lets an admin's JWT delete *someone else's*
    account.
    """
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required.")
    client = get_client()
    if client is None:
        raise HTTPException(status_code=500, detail="Account deletion is not configured on this server.")
    # Read the address first: the profile is gone once the user is deleted.
    target_email = None
    try:
        rows = client.table("profiles").select("email").eq("id", target_user_id).limit(1).execute().data
        target_email = rows[0].get("email") if rows else None
    except Exception:
        logger.exception("Couldn't read email for user_id=%s before deletion", target_user_id)
    _purge_user_storage(client, target_user_id)
    try:
        client.auth.admin.delete_user(target_user_id)
    except Exception:
        logger.exception("Admin %s failed to force-delete user_id=%s", user.user_id, target_user_id)
        raise HTTPException(status_code=500, detail="Failed to delete account.")
    background.add_task(notifications.notify_account_deleted, target_email)
    return {"deleted": True, "user_id": target_user_id}
