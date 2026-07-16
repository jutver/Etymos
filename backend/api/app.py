from __future__ import annotations

import os
import shutil
import tempfile
import threading
import traceback
from pathlib import Path
import sys
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
sys.path.append(str(Path(__file__).parent.parent))
from job_manager import create_job, get_job, make_progress_callback, update_job
from report_store import delete_report, get_report, list_reports, save_report
from main import check_pdf_plagiarism
from doan_van import check_text_plagiarism

app = FastAPI(title="Academic Plagiarism Checker API", version="0.1.0")

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


class TextCheckRequest(BaseModel):
    text: str = Field(min_length=30, max_length=100_000)


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "plagiarism-checker"}


def run_pdf_job(*, job_id: str, pdf_path: str, original_name: str) -> None:
    callback = make_progress_callback(job_id)
    try:
        update_job(job_id, status="processing", progress=1,
                   current_step="starting", message="Starting PDF analysis")
        report = check_pdf_plagiarism(pdf_path=pdf_path, progress_callback=callback)
        report_id = save_report(report, input_type="pdf", input_name=original_name)
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


@app.get("/api/reports")
def read_reports():
    return {"items": list_reports()}


@app.delete("/api/reports/{report_id}")
def remove_report(report_id: str):
    if not delete_report(report_id):
        raise HTTPException(status_code=404, detail="Report not found.")
    return {"deleted": True, "report_id": report_id}
