from __future__ import annotations

import json
import os
import threading
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPORT_DIR = Path(os.getenv(
    "REPORT_DIR",
    "/content/drive/MyDrive/Check_Dao_Van/api_reports"
    if os.path.exists("/content/drive/MyDrive") else "./api_reports",
))
_REPORTS: dict[str, dict[str, Any]] = {}
_LOCK = threading.Lock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def init_report_store() -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)


def save_report(report: dict[str, Any], *, input_type: str,
                input_name: str | None = None) -> str:
    init_report_store()
    report_id = f"report_{uuid.uuid4().hex}"
    wrapped = {
        "report_id": report_id,
        "status": "completed",
        "input": {"type": input_type, "name": input_name},
        "created_at": _now_iso(),
        **report,
    }
    path = REPORT_DIR / f"{report_id}.json"
    with path.open("w", encoding="utf-8") as f:
        json.dump(wrapped, f, ensure_ascii=False, indent=2)
    with _LOCK:
        _REPORTS[report_id] = wrapped
    return report_id


def get_report(report_id: str) -> dict[str, Any] | None:
    with _LOCK:
        cached = _REPORTS.get(report_id)
        if cached is not None:
            return deepcopy(cached)
    path = REPORT_DIR / f"{report_id}.json"
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as f:
        report = json.load(f)
    with _LOCK:
        _REPORTS[report_id] = report
    return deepcopy(report)


def list_reports() -> list[dict[str, Any]]:
    init_report_store()
    reports = []
    for path in sorted(REPORT_DIR.glob("report_*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            with path.open("r", encoding="utf-8") as f:
                report = json.load(f)
            reports.append({
                "report_id": report.get("report_id"),
                "status": report.get("status"),
                "input": report.get("input", {}),
                "overall_score": report.get("overall_score", 0),
                "created_at": report.get("created_at"),
            })
        except (OSError, json.JSONDecodeError):
            continue
    return reports


def delete_report(report_id: str) -> bool:
    path = REPORT_DIR / f"{report_id}.json"
    deleted = False
    if path.exists():
        path.unlink()
        deleted = True
    with _LOCK:
        if report_id in _REPORTS:
            del _REPORTS[report_id]
            deleted = True
    return deleted
