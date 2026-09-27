from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from supabase_client import get_client

logger = logging.getLogger(__name__)

REPORT_DIR = Path(os.getenv(
    "REPORT_DIR",
    "/content/drive/MyDrive/Check_Dao_Van/api_reports"
    if os.path.exists("/content/drive/MyDrive") else "./api_reports",
))
_REPORTS: dict[str, dict[str, Any]] = {}
_LOCK = threading.Lock()

# Per-match severity thresholds on matchPercent (= semantic_similarity *
# 100): Low <20, Moderate 20-60, High >60. Previously this was categorical
# (a 3-value `label` -> severity dict) and never looked at the actual
# score, so two matches with wildly different similarity but the same
# label always rendered the same severity. This is intentionally
# DIFFERENT from `_status_from_score` below (a whole-document aggregate
# over `overall_score` with its own 30/10 thresholds) and the frontend's
# Severity.tsx (15/30/50) — those are a separate metric, left as-is.
_SEVERITY_HIGH_THRESHOLD = 60
_SEVERITY_MODERATE_THRESHOLD = 20


def _severity_from_percent(percent: float) -> str:
    if percent > _SEVERITY_HIGH_THRESHOLD:
        return "high"
    if percent >= _SEVERITY_MODERATE_THRESHOLD:
        return "moderate"
    return "low"


# Cap how many individual sentence matches we normalize into
# `document_matches` per report, to keep the write bounded/cheap. The full
# match list always remains available in the local/in-memory report cache.
# Previously 50, which silently dropped every match past the first 50 on
# the Supabase-reload path (a reopened/reloaded report) even though the
# live, same-session Analyzing view showed them all. Raised substantially;
# a cap is kept at all (rather than removed outright) only to protect
# against a truly pathological document generating an unbounded number of
# rows in one write.
_MAX_PERSISTED_MATCHES = 500

# Same bucket/path convention as `_upload_pdf` in api/app.py (`{user_id}/
# {report_id}.pdf`), extended with an `images/{n}.{ext}` suffix — this
# keeps every image under the same per-user prefix the bucket's Storage
# RLS policies already key on ((storage.foldername(name))[1] = auth.uid()),
# so no new bucket/policy is needed (see
# supabase/migrations/20260716120000_student_verification_and_audit_log.sql).
# Duplicated here (rather than imported from api.app) to avoid a circular
# import — api/app.py already imports this module.
_IMAGES_BUCKET = os.getenv("SUPABASE_STORAGE_BUCKET", "documents")

# How long an image's signed URL stays valid. There is no resign-on-read
# endpoint (the way `/api/reports/{id}/source-pdf` resigns the PDF on every
# request) — this is a known limitation: an `image_url` persisted today
# will eventually expire. A long-lived signed URL is the pragmatic
# best-effort choice for this pass rather than adding a new endpoint /
# making the bucket public; revisit if images need to keep working past
# this window without a fresh report load re-triggering an upload.
_IMAGE_SIGNED_URL_SECONDS = 60 * 60 * 24 * 365  # 1 year


def _image_storage_path(user_id: str, report_id: str, index: int, ext: str) -> str:
    return f"{user_id}/{report_id}/images/{index}.{ext}"


def _extract_and_upload_images(report_id: str, report: dict[str, Any], user_id: Optional[str]) -> None:
    """
    Best-effort: upload every extracted image (docx inline pictures /
    PDF page images — see extract_docx.py / extractor.py) to Supabase
    Storage and set `image_url` on its block, so the Document view can
    render a real `<img>` instead of the placeholder box.

    Always strips the raw `_image_bytes` / `_image_ext` carrier fields off
    every image block before returning, regardless of upload
    success/failure — those bytes are an in-process-only handoff and are
    never JSON-serializable, so leaving them on a block would crash the
    plain `json.dump` local-fallback write in save_report() below. This
    function MUST run (and MUST NOT raise) before that write.

    No-ops (but still strips) when Supabase isn't configured or there is
    no authenticated owner to scope the upload path to — same condition
    `_persist_to_supabase` already treats as "nothing to persist".
    """
    document = report.get("document") or {}
    blocks = document.get("blocks") or []

    try:
        image_blocks = [
            b for b in blocks if isinstance(b, dict) and b.get("type") == "image"
            and b.get("_image_bytes") is not None
        ]
        if not image_blocks:
            return

        client = get_client() if user_id is not None else None

        for index, block in enumerate(image_blocks):
            image_bytes = block.pop("_image_bytes", None)
            ext = block.pop("_image_ext", None) or "png"
            if client is None or not image_bytes:
                continue
            try:
                path = _image_storage_path(user_id, report_id, index, ext)
                content_type = "image/jpeg" if ext in ("jpg", "jpeg") else f"image/{ext}"
                client.storage.from_(_IMAGES_BUCKET).upload(
                    path, image_bytes,
                    file_options={"content-type": content_type, "upsert": "true"},
                )
                signed = client.storage.from_(_IMAGES_BUCKET).create_signed_url(
                    path, _IMAGE_SIGNED_URL_SECONDS
                )
                signed_url = (signed or {}).get("signedURL") or (signed or {}).get("signed_url")
                if signed_url:
                    block["image_url"] = signed_url
            except Exception:
                logger.exception(
                    "Failed to upload extracted image %d for report_id=%s", index, report_id
                )
    except Exception:
        logger.exception("Unexpected failure extracting/uploading images for report_id=%s", report_id)
    finally:
        # Never let raw bytes escape this function on ANY block, no matter
        # what went wrong above — this is what makes it safe to call
        # unconditionally right before a json.dump of the report.
        for block in blocks:
            if isinstance(block, dict):
                block.pop("_image_bytes", None)
                block.pop("_image_ext", None)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def init_report_store() -> None:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)


def _status_from_score(score: float) -> str:
    """
    Map the pipeline's overall_score (0-100) onto the severity buckets
    allowed by documents.status's check constraint
    (supabase/migrations/20260715120100_documents.sql): clean/low/moderate/high.
    """
    if score >= 30:
        return "high"
    if score >= 10:
        return "moderate"
    if score > 0:
        return "low"
    return "clean"


def _persist_to_supabase(report_id: str, report: dict[str, Any], *,
                          user_id: Optional[str], input_type: str,
                          input_name: Optional[str]) -> None:
    """
    Upsert the completed report into Supabase (`documents` +
    `document_matches`) so it survives a process restart / redeploy, not
    just the lifetime of this container's local disk / in-memory cache.
    Best-effort: any failure is logged, never raised, so a Supabase outage
    can't break the API response the caller already has.
    """
    client = get_client()
    if client is None or user_id is None:
        # No Supabase configured (local dev), or no authenticated owner to
        # scope this report to (e.g. a bare script run) — nothing to persist.
        return

    overall_score = float(report.get("overall_score", 0.0) or 0.0)

    try:
        document_row = {
            "id": report_id,
            "user_id": user_id,
            "title": input_name or ("Pasted text" if input_type == "text" else "Untitled"),
            "file_name": input_name if input_type == "pdf" else None,
            "status": _status_from_score(overall_score),
            "similarity_score": overall_score,
            "uploaded_at": _now_iso(),
        }
        client.table("documents").upsert(document_row, on_conflict="id").execute()
    except Exception:
        logger.exception("Failed to upsert documents row for report_id=%s", report_id)
        return  # No point trying to insert matches for a document row that didn't land.

    # AI-content detection result (report_enrichment.py). Written as its own
    # UPDATE, apart from the upsert above, on purpose: if the
    # `documents.ai_detection` column doesn't exist yet (migration not applied)
    # only this write fails — the report itself must still persist exactly as
    # before.
    ai_detection = report.get("ai_detection")
    if ai_detection:
        try:
            client.table("documents").update({"ai_detection": ai_detection}).eq("id", report_id).execute()
        except Exception as exc:
            logger.warning(
                "Could not persist ai_detection for report_id=%s "
                "(has supabase/migrations/20260727000100_documents_ai_detection.sql been applied?): %s",
                report_id, exc,
            )

    try:
        matches = report.get("matches") or []
        rows = []
        for m in matches[:_MAX_PERSISTED_MATCHES]:
            semantic_similarity = float(m.get("semantic_similarity", 0.0) or 0.0)
            match_percent = round(semantic_similarity * 100, 2)
            source_authors = m.get("source_authors") or []
            if isinstance(source_authors, list):
                source_author = ", ".join(str(a) for a in source_authors if str(a).strip()) or None
            else:
                source_author = str(source_authors).strip() or None
            # source_kind's check constraint only allows 'web'/'academic' —
            # final_report_builder.py now attaches this on every match
            # (default "academic" when the source couldn't be classified),
            # so this is never actually None in practice, but the fallback
            # keeps this insert valid for any pre-existing report shape.
            source_kind = m.get("source_kind") or "academic"
            rows.append({
                "document_id": report_id,
                "severity": _severity_from_percent(match_percent),
                "detection_type": "semantic",
                "match_percent": match_percent,
                "source_title": m.get("source_title") or None,
                "source_author": source_author,
                "source_kind": source_kind,
                "citation": None,
                "user_snippet": m.get("input_sentence") or None,
                "source_snippet": m.get("source_sentence") or None,
                # Real per-match explanation from final_report_builder.py
                # when present (references this match's own similarity
                # score/source/excerpt); fall back to the old word/char
                # overlap summary only for reports built before that field
                # existed.
                "explanation": m.get("explanation") or (
                    f"word overlap {m.get('word_overlap', 0):.2f}, "
                    f"char n-gram overlap {m.get('char_ngram_overlap', 0):.2f}"
                    if m.get("word_overlap") is not None else None
                ),
                "rewrite_suggestions": None,
            })
        # Idempotent re-save: clear any previous match rows for this
        # document before inserting the current set.
        client.table("document_matches").delete().eq("document_id", report_id).execute()
        if rows:
            client.table("document_matches").insert(rows).execute()
    except Exception:
        logger.exception("Failed to persist document_matches for report_id=%s", report_id)

    try:
        document = report.get("document") or {}
        blocks = document.get("blocks") or []
        # final_report_builder.py stores the document text under
        # report["input_text"] (see its "text_field": "input_text" marker)
        # rather than duplicating it into report["document"]["text"] — fall
        # back to the latter only for callers/tests that didn't follow that
        # convention.
        document_text = report.get("input_text") or document.get("text") or ""
        # Unlike the document_matches loop above, this uses the FULL match
        # list (no _MAX_PERSISTED_MATCHES cap) — every block needs a chance
        # to find its matching sentence, not just the first 50 matches.
        all_matches = report.get("matches") or []

        passage_rows = []
        for sort_order, block in enumerate(blocks):
            start = block.get("start")
            end = block.get("end")
            if start is None or end is None:
                continue
            text = document_text[start:end].strip()
            # A section heading is zero-length too, but carries its words in
            # "text" (see document_model._interleave_section_headings).
            if not text and block.get("section_heading"):
                text = (block.get("text") or "").strip()
            # An "image" block is zero-length by construction (see
            # document_model._interleave_image_blocks — it has no text of
            # its own, only a position) and must NOT be dropped here the
            # way an accidentally-empty text block should be; every other
            # block type keeps the original "no text -> nothing to
            # persist" behaviour unchanged.
            if not text and block.get("type") != "image":
                continue

            # Mirrors buildPassagesFromBlocks() in
            # apps/web/src/screens/Analyzing/index.tsx: document_matches has
            # no offset columns, so the only heuristic available here (same
            # as client-side for offset-less matches) is snippet
            # equality/containment against the first matching entry.
            matched = None
            for m in all_matches:
                snippet = (m.get("input_sentence") or "").strip()
                if snippet and (text == snippet or snippet in text):
                    matched = m
                    break

            table_rows = block.get("rows")

            passage_rows.append({
                "document_id": report_id,
                "text": text,
                "severity": (
                    _severity_from_percent(
                        round(float(matched.get("semantic_similarity", 0.0) or 0.0) * 100, 2)
                    )
                    if matched else None
                ),
                # Left null: matches are re-inserted with freshly generated
                # ids on every save, and correlating this heuristic match
                # back to its post-insert row id isn't worth the added
                # complexity/risk — `severity` alone (plus the frontend's own
                # text-based highlight fallback in highlights.ts) is enough
                # to render passage highlighting correctly.
                "match_id": None,
                "sort_order": sort_order,
                "block_type": block.get("type"),
                "level": block.get("level"),
                "list_type": block.get("list_type"),
                "page": block.get("page"),
                "table_rows": table_rows if table_rows is not None else None,
                "image_url": block.get("image_url"),
                # Inline bold/italic ranges (supabase/migrations/
                # 20260927000000_document_passage_text_marks.sql).
                "text_marks": block.get("marks") or None,
            })

        # Idempotent re-save, same pattern as document_matches above.
        client.table("document_passages").delete().eq("document_id", report_id).execute()
        if passage_rows:
            try:
                client.table("document_passages").insert(passage_rows).execute()
            except Exception:
                # Most likely the text_marks migration hasn't been applied
                # yet: keep the passages, just without inline formatting.
                logger.warning(
                    "Inserting document_passages with text_marks failed for report_id=%s; "
                    "retrying without inline formatting.", report_id, exc_info=True,
                )
                client.table("document_passages").insert(
                    [{k: v for k, v in row.items() if k != "text_marks"} for row in passage_rows]
                ).execute()
    except Exception:
        logger.exception("Failed to persist document_passages for report_id=%s", report_id)


def _delete_from_supabase(report_id: str) -> bool:
    client = get_client()
    if client is None:
        return False
    try:
        # document_matches cascade-deletes via FK (on delete cascade), so
        # deleting the documents row is enough.
        resp = client.table("documents").delete().eq("id", report_id).execute()
        return bool(resp.data)
    except Exception:
        logger.exception("Failed to delete documents row for report_id=%s", report_id)
        return False


def _fetch_from_supabase(report_id: str) -> Optional[dict[str, Any]]:
    client = get_client()
    if client is None:
        return None
    try:
        doc_resp = client.table("documents").select("*").eq("id", report_id).maybe_single().execute()
        doc = doc_resp.data if doc_resp else None
        if not doc:
            return None
        matches_resp = (
            client.table("document_matches")
            .select("*")
            .eq("document_id", report_id)
            .execute()
        )
        matches = matches_resp.data or []
        return {
            "report_id": report_id,
            "status": "completed",
            "input": {"type": "pdf" if doc.get("file_name") else "text", "name": doc.get("file_name") or doc.get("title")},
            "user_id": doc.get("user_id"),
            "created_at": doc.get("uploaded_at"),
            "overall_score": doc.get("similarity_score"),
            "document_status": doc.get("status"),
            "ai_detection": doc.get("ai_detection"),
            "matches": matches,
        }
    except Exception:
        logger.exception("Failed to fetch report_id=%s from Supabase", report_id)
        return None


def _list_from_supabase(user_id: Optional[str], is_admin: bool) -> Optional[list[dict[str, Any]]]:
    client = get_client()
    if client is None:
        return None
    try:
        query = client.table("documents").select("*").order("uploaded_at", desc=True)
        if not is_admin:
            query = query.eq("user_id", user_id)
        resp = query.execute()
        return [
            {
                "report_id": d.get("id"),
                "status": "completed",
                "input": {"type": "pdf" if d.get("file_name") else "text", "name": d.get("title")},
                "overall_score": d.get("similarity_score") or 0,
                "created_at": d.get("uploaded_at"),
            }
            for d in (resp.data or [])
        ]
    except Exception:
        logger.exception("Failed to list documents from Supabase")
        return None


def save_report(report: dict[str, Any], *, input_type: str,
                 input_name: str | None = None,
                 user_id: str | None = None) -> str:
    init_report_store()
    report_id = str(uuid.uuid4())

    # Must run before the json.dump below: it strips the raw-bytes carrier
    # fields (`_image_bytes`/`_image_ext`) every image block may still be
    # holding, which json.dump cannot serialize. Best-effort and
    # exception-safe internally — never raises.
    try:
        _extract_and_upload_images(report_id, report, user_id)
    except Exception:
        logger.exception("Image extraction/upload failed for report_id=%s", report_id)

    wrapped = {
        "report_id": report_id,
        "status": "completed",
        "input": {"type": input_type, "name": input_name},
        "user_id": user_id,
        "created_at": _now_iso(),
        **report,
    }
    path = REPORT_DIR / f"{report_id}.json"
    with path.open("w", encoding="utf-8") as f:
        json.dump(wrapped, f, ensure_ascii=False, indent=2)
    with _LOCK:
        _REPORTS[report_id] = wrapped

    _persist_to_supabase(report_id, report, user_id=user_id,
                         input_type=input_type, input_name=input_name)

    return report_id


def get_report(report_id: str) -> dict[str, Any] | None:
    # 1. Fast path: in-memory cache (this process already handled it).
    with _LOCK:
        cached = _REPORTS.get(report_id)
        if cached is not None:
            return deepcopy(cached)

    # 2. Source of truth: Supabase (survives restarts / redeploys where
    #    local disk is ephemeral, e.g. a container redeploy).
    from_supabase = _fetch_from_supabase(report_id)
    if from_supabase is not None:
        with _LOCK:
            _REPORTS[report_id] = from_supabase
        return deepcopy(from_supabase)

    # 3. Last-resort fallback: local JSON file (useful in local dev without
    #    Supabase configured, or if Supabase is briefly unreachable).
    path = REPORT_DIR / f"{report_id}.json"
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as f:
        report = json.load(f)
    with _LOCK:
        _REPORTS[report_id] = report
    return deepcopy(report)


def list_reports(user_id: str | None = None, is_admin: bool = False) -> list[dict[str, Any]]:
    from_supabase = _list_from_supabase(user_id, is_admin)
    if from_supabase is not None:
        return from_supabase

    # Local fallback (no Supabase configured): filter the local JSON store
    # by the wrapped "user_id" field written in save_report, so this still
    # respects per-user scoping in dev.
    init_report_store()
    reports = []
    for path in sorted(REPORT_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            with path.open("r", encoding="utf-8") as f:
                report = json.load(f)
            if not is_admin and user_id is not None and report.get("user_id") not in (None, user_id):
                continue
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
    if _delete_from_supabase(report_id):
        deleted = True
    return deleted
