from __future__ import annotations

import os
import shutil
import tempfile
import threading
import traceback
from pathlib import Path
import sys
import google.generativeai as genai
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

# Cấu hình hệ thống
sys.path.append(str(Path(__file__).parent.parent))
from job_manager import create_job, get_job, make_progress_callback, update_job
from report_store import delete_report, get_report, list_reports, save_report
from main import check_pdf_plagiarism
from doan_van import check_text_plagiarism

app = FastAPI(title="Academic Plagiarism Checker API", version="0.1.0")

# Cấu hình CORS
allowed_origins_env = os.getenv("ALLOWED_ORIGINS", "*")
allowed_origins = ["*"] if allowed_origins_env.strip() == "*" else [
    origin.strip() for origin in allowed_origins_env.split(",") if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False if allowed_origins == ["*"] else True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Cấu hình AI Gemini
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "AIzaSyDWRQ0hzhapT_oKzlE7sLuhzrPhRdUrIM0")
genai.configure(api_key=GEMINI_API_KEY)

# Thư mục lưu trữ PDF vĩnh viễn
PERMANENT_PDF_DIR = Path("storage/processed_pdfs")
PERMANENT_PDF_DIR.mkdir(parents=True, exist_ok=True)


class TextCheckRequest(BaseModel):
    text: str = Field(min_length=30, max_length=100_000)

class RewriteRequest(BaseModel):
    input_sentence: str
    source_sentence: str


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "plagiarism-checker"}


def run_pdf_job(*, job_id: str, pdf_path: str, original_name: str) -> None:
    callback = make_progress_callback(job_id)
    is_moved_to_storage = False

    try:
        update_job(job_id, status="processing", progress=1,
                   current_step="starting", message="Starting PDF analysis")
                   
        report = check_pdf_plagiarism(pdf_path=pdf_path, progress_callback=callback)
        report_id = save_report(report, input_type="pdf", input_name=original_name)
        
        # Chuyển file PDF sang kho lưu trữ vĩnh viễn
        permanent_path = PERMANENT_PDF_DIR / f"{report_id}.pdf"
        shutil.move(pdf_path, permanent_path)
        is_moved_to_storage = True
        
        update_job(job_id, status="completed", progress=100,
                   current_step="completed", message="Analysis complete",
                   report_id=report_id)
    except Exception as exc:
        traceback.print_exc()
        update_job(job_id, status="failed", current_step="failed",
                   message="PDF analysis failed", error=str(exc))
    finally:
        if not is_moved_to_storage and Path(pdf_path).exists():
            try:
                Path(pdf_path).unlink(missing_ok=True)
            except OSError:
                pass
        try:
            Path(pdf_path).parent.rmdir()
        except OSError:
            pass


def run_text_job(*, job_id: str, user_text: str) -> None:
    callback = make_progress_callback(job_id)
    try:
        update_job(job_id, status="processing", progress=1,
                   current_step="starting", message="Starting text analysis")
        report = check_text_plagiarism(user_text=user_text, progress_callback=callback)
        report_id = save_report(report, input_type="text", input_name="Pasted text")
        update_job(job_id, status="completed", progress=100,
                   current_step="completed", message="Analysis complete",
                   report_id=report_id)
    except Exception as exc:
        traceback.print_exc()
        update_job(job_id, status="failed", current_step="failed",
                   message="Text analysis failed", error=str(exc))


@app.post("/api/check/pdf", status_code=202)
async def create_pdf_check(file: UploadFile = File(...)):
    filename = file.filename or "uploaded.pdf"
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    job_id = create_job(input_type="pdf", input_name=filename)
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
        kwargs={"job_id": job_id, "pdf_path": str(pdf_path), "original_name": filename},
        daemon=True,
    ).start()

    return {"job_id": job_id, "status": "queued", "input_type": "pdf"}


@app.post("/api/check/text", status_code=202)
def create_text_check(request: TextCheckRequest):
    job_id = create_job(input_type="text", input_name="Pasted text")
    threading.Thread(
        target=run_text_job,
        kwargs={"job_id": job_id, "user_text": request.text.strip()},
        daemon=True,
    ).start()
    return {"job_id": job_id, "status": "queued", "input_type": "text"}


@app.get("/api/jobs/{job_id}")
def read_job(job_id: str):
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found.")
    return job


@app.get("/api/reports/{report_id}")
def read_report(report_id: str):
    report = get_report(report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Report not found.")
    return report


@app.get("/api/reports/{report_id}/source-pdf")
def get_source_pdf(report_id: str):
    pdf_file_path = PERMANENT_PDF_DIR / f"{report_id}.pdf"
    if not pdf_file_path.exists():
        raise HTTPException(status_code=404, detail="Không tìm thấy file PDF gốc cho báo cáo này.")
    return FileResponse(path=pdf_file_path, media_type="application/pdf", filename=f"{report_id}.pdf")


@app.post("/api/ai/rewrite")
def rewrite_text_with_ai(request: RewriteRequest):
    if not GEMINI_API_KEY or GEMINI_API_KEY == "co cai con cac con cac con":
        raise HTTPException(status_code=500, detail="Có cái con cặc, con cặc con")
    try:
        model = genai.GenerativeModel('gemini-flash-latest')
        prompt = f"""
        Viết lại đoạn văn bị đánh dấu đạo văn, giữ nguyên ý nghĩa học thuật. 
        Lưu ý: Văn bản này được trích xuất từ PDF nên có thể bị lỗi ký tự lạ (•). Hãy bỏ qua chúng.
        
        [VĂN BẢN GỐC]: "{request.source_sentence}"
        [ĐOẠN VĂN NGƯỜI DÙNG]: "{request.input_sentence}"
        
        Yêu cầu: Viết lại đoạn văn người dùng, paraphrase để giảm đạo văn, tuyệt đối không trả về ký tự lạ. 
        Chỉ trả về nội dung đã viết lại, không giải thích.
        """
        response = model.generate_content(prompt)
        return {"success": True, "rewritten_text": response.text.strip()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/reports")
def read_reports():
    return {"items": list_reports()}


@app.delete("/api/reports/{report_id}")
def remove_report(report_id: str):
    if not delete_report(report_id):
        raise HTTPException(status_code=404, detail="Report not found.")
    pdf_file_path = PERMANENT_PDF_DIR / f"{report_id}.pdf"
    pdf_file_path.unlink(missing_ok=True)
    return {"deleted": True, "report_id": report_id}