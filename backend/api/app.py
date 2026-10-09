

import logging
import os
import shutil
import tempfile
import threading
import traceback
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
import sys
from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel, Field
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

# Cấu hình hệ thống
sys.path.append(str(Path(__file__).parent.parent))
sys.path.append(str(Path(__file__).parent))
from job_manager import create_job, get_job, make_progress_callback, make_queue_callback, update_job
from gpu_queue import gpu_slot
from report_store import delete_report, get_report, list_reports, save_report
from main import check_pdf_plagiarism, check_docx_plagiarism
from doan_van import check_text_plagiarism
from ai_rewrite import RewriteUnavailable, register_flag as register_rewrite_flag, rewrite_sentence
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
from usage import ensure_quota_available, record_check_used
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
# Citing is a cheap pure-text transform, so it gets a much looser limit
# than the model-backed endpoints — a user adding a bibliography can
# easily insert dozens of citations in one editing session.
RATE_LIMIT_CITE = os.getenv("RATE_LIMIT_CITE", "300/hour")

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

class RewriteRequest(BaseModel):
    input_sentence: str
    source_sentence: str


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
    return {"status": "ok", "service": "plagiarism-checker"}


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
        # marker-pdf loads its own models onto the GPU, so it takes a slot like a check.
        with gpu_slot():
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


def run_pdf_job(*, job_id: str, pdf_path: str, original_name: str, user_id: str | None,
                 balance_source: BalanceSource, input_type: Literal["pdf", "docx"] = "pdf") -> None:
    """
    Runs either extraction pipeline depending on `input_type`. Named
    run_pdf_job (not renamed to something generic) because it is still
    reached exclusively via the `/api/check/pdf` endpoint below, which now
    accepts both extensions — see create_pdf_check().

    Original-PDF Storage upload (`_upload_pdf`) only happens for actual
    PDFs: a .docx has no PDF rendering to show in the Report page's
    Original view (owned by MarkerDocumentViewer.tsx, via the marker-pdf
    preview kicked off right below), so that view simply has nothing to
    switch to for a docx-sourced report — the Document view is the only
    view, which is the correct degraded behaviour rather than uploading the
    wrong bytes under a `.pdf`-suffixed Storage key.
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

        report_id = save_report(report, input_type=input_type, input_name=original_name, user_id=user_id)

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

        update_job(job_id, status="completed", progress=100,
                   current_step="completed", message="Analysis complete",
                   report_id=report_id)
        if user_id is not None:
            record_check_used(user_id, balance_source)
    except Exception as exc:
        traceback.print_exc()
        update_job(job_id, status="failed", current_step="failed",
                   message=f"{'DOCX' if input_type == 'docx' else 'PDF'} analysis failed", error=str(exc))
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
        report_id = save_report(report, input_type="text", input_name="Pasted text", user_id=user_id)
        update_job(job_id, status="completed", progress=100,
                   current_step="completed", message="Analysis complete",
                   report_id=report_id)
        if user_id is not None:
            record_check_used(user_id, balance_source)
    except Exception as exc:
        traceback.print_exc()
        update_job(job_id, status="failed", current_step="failed",
                   message="Text analysis failed", error=str(exc))


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
    try:
        result = rewrite_sentence(
            input_sentence=body.input_sentence,
            source_sentence=body.source_sentence,
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
    }


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
