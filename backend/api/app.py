

import logging
import os
import shutil
import tempfile
import threading
import traceback
from pathlib import Path
import sys
import google.generativeai as genai
from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel, Field
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from slowapi.util import get_remote_address

# Cấu hình hệ thống
sys.path.append(str(Path(__file__).parent.parent))
sys.path.append(str(Path(__file__).parent))
from job_manager import create_job, get_job, make_progress_callback, update_job
from report_store import delete_report, get_report, list_reports, save_report
from main import check_pdf_plagiarism
from doan_van import check_text_plagiarism
from auth import AuthedUser, require_owner_or_admin, verify_supabase_jwt
from supabase_client import get_client

logger = logging.getLogger(__name__)

app = FastAPI(title="Academic Plagiarism Checker API", version="0.1.0")

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

# Cấu hình rate limiting (slowapi), keyed by verified user_id when
# available (request.state.user, set by auth.verify_supabase_jwt), else by
# client IP. Limits are configurable via env vars, not hardcoded magic
# numbers.
def _rate_limit_key(request: Request) -> str:
    user = getattr(request.state, "user", None)
    if user is not None:
        return f"user:{user.user_id}"
    return f"ip:{get_remote_address(request)}"


limiter = Limiter(key_func=_rate_limit_key)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

RATE_LIMIT_CHECK_PDF = os.getenv("RATE_LIMIT_CHECK_PDF", "10/hour")
RATE_LIMIT_CHECK_TEXT = os.getenv("RATE_LIMIT_CHECK_TEXT", "20/hour")
RATE_LIMIT_AI_REWRITE = os.getenv("RATE_LIMIT_AI_REWRITE", "30/hour")

# Cấu hình AI Gemini
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if not GEMINI_API_KEY:
    logger.warning(
        "GEMINI_API_KEY is not set; /api/ai/rewrite will return 500 until it is configured."
    )
else:
    genai.configure(api_key=GEMINI_API_KEY)

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


class TextCheckRequest(BaseModel):
    text: str = Field(min_length=30, max_length=100_000)

class RewriteRequest(BaseModel):
    input_sentence: str
    source_sentence: str


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "plagiarism-checker"}


def run_pdf_job(*, job_id: str, pdf_path: str, original_name: str, user_id: str | None) -> None:
    callback = make_progress_callback(job_id)

    try:
        update_job(job_id, status="processing", progress=1,
                   current_step="starting", message="Starting PDF analysis")

        report = check_pdf_plagiarism(pdf_path=pdf_path, progress_callback=callback)
        report_id = save_report(report, input_type="pdf", input_name=original_name, user_id=user_id)

        if user_id is not None:
            _upload_pdf(user_id, report_id, Path(pdf_path))

        update_job(job_id, status="completed", progress=100,
                   current_step="completed", message="Analysis complete",
                   report_id=report_id)
    except Exception as exc:
        traceback.print_exc()
        update_job(job_id, status="failed", current_step="failed",
                   message="PDF analysis failed", error=str(exc))
    finally:
        try:
            Path(pdf_path).unlink(missing_ok=True)
        except OSError:
            pass
        try:
            Path(pdf_path).parent.rmdir()
        except OSError:
            pass


def run_text_job(*, job_id: str, user_text: str, user_id: str | None) -> None:
    callback = make_progress_callback(job_id)
    try:
        update_job(job_id, status="processing", progress=1,
                   current_step="starting", message="Starting text analysis")
        report = check_text_plagiarism(user_text=user_text, progress_callback=callback)
        report_id = save_report(report, input_type="text", input_name="Pasted text", user_id=user_id)
        update_job(job_id, status="completed", progress=100,
                   current_step="completed", message="Analysis complete",
                   report_id=report_id)
    except Exception as exc:
        traceback.print_exc()
        update_job(job_id, status="failed", current_step="failed",
                   message="Text analysis failed", error=str(exc))


@app.post("/api/check/pdf", status_code=202)
@limiter.limit(RATE_LIMIT_CHECK_PDF)
async def create_pdf_check(request: Request, file: UploadFile = File(...),
                            user: AuthedUser = Depends(verify_supabase_jwt)):
    filename = file.filename or "uploaded.pdf"
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    job_id = create_job(input_type="pdf", input_name=filename, user_id=user.user_id)
    temp_dir = Path(tempfile.mkdtemp(prefix=f"{job_id}_"))
    pdf_path = temp_dir / "input.pdf"

    try:
        with pdf_path.open("wb") as output:
            shutil.copyfileobj(file.file, output)
    finally:
        await file.close()

    if pdf_path.stat().st_size == 0:
        pdf_path.unlink(missing_ok=True)
        temp_dir.rmdir()
        raise HTTPException(status_code=400, detail="Uploaded PDF is empty.")

    threading.Thread(
        target=run_pdf_job,
        kwargs={"job_id": job_id, "pdf_path": str(pdf_path), "original_name": filename, "user_id": user.user_id},
        daemon=True,
    ).start()

    return {"job_id": job_id, "status": "queued", "input_type": "pdf"}


@app.post("/api/check/text", status_code=202)
@limiter.limit(RATE_LIMIT_CHECK_TEXT)
def create_text_check(request: Request, body: TextCheckRequest,
                       user: AuthedUser = Depends(verify_supabase_jwt)):
    job_id = create_job(input_type="text", input_name="Pasted text", user_id=user.user_id)
    threading.Thread(
        target=run_text_job,
        kwargs={"job_id": job_id, "user_text": body.text.strip(), "user_id": user.user_id},
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


@app.post("/api/ai/rewrite")
@limiter.limit(RATE_LIMIT_AI_REWRITE)
def rewrite_text_with_ai(request: Request, body: RewriteRequest,
                          user: AuthedUser = Depends(verify_supabase_jwt)):
    if not GEMINI_API_KEY:
        raise HTTPException(status_code=500, detail="AI rewrite is not configured on the server.")
    try:
        model = genai.GenerativeModel('gemini-flash-latest')
        prompt = f"""
        Viết lại đoạn văn bị đánh dấu đạo văn, giữ nguyên ý nghĩa học thuật.
        Lưu ý: Văn bản này được trích xuất từ PDF nên có thể bị lỗi ký tự lạ (•). Hãy bỏ qua chúng.

        [VĂN BẢN GỐC]: "{body.source_sentence}"
        [ĐOẠN VĂN NGƯỜI DÙNG]: "{body.input_sentence}"

        Yêu cầu: Viết lại đoạn văn người dùng, paraphrase để giảm đạo văn, tuyệt đối không trả về ký tự lạ.
        Chỉ trả về nội dung đã viết lại, không giải thích.
        """
        response = model.generate_content(prompt)
        return {"success": True, "rewritten_text": response.text.strip()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
    return {"deleted": True, "report_id": report_id}


@app.delete("/api/account")
def delete_account(user: AuthedUser = Depends(verify_supabase_jwt)):
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
    try:
        client.auth.admin.delete_user(user.user_id)
    except Exception:
        logger.exception("Failed to delete account for user_id=%s", user.user_id)
        raise HTTPException(status_code=500, detail="Failed to delete account.")
    return {"deleted": True, "user_id": user.user_id}
