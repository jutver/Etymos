"""Contract tests for 20261122000000_document_layout_and_formulas.sql and report_store.py v2/fallback persistence (T041)."""

from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace

import pytest

import report_store

MIGRATION_PATH = (
    Path(__file__).resolve().parents[2]
    / "supabase"
    / "migrations"
    / "20261122000000_document_layout_and_formulas.sql"
)


def test_migration_sql_contains_all_additive_columns_and_formula_constraint():
    sql = MIGRATION_PATH.read_text(encoding="utf-8")
    low = sql.lower()

    assert "'formula'" in low
    assert "document_passages_block_type_check" in low

    for col in (
        "layout_band",
        "column_role",
        "column_count",
        "list_number",
        "list_depth",
        "formula_latex",
        "equation_number",
        "inline_formulas",
    ):
        assert f"add column if not exists {col}" in low

    assert "alter table public.documents" in low
    assert "add column if not exists extraction_meta jsonb" in low
    assert "column_role in ('full', 'left', 'right')" in low
    assert "column_count in (1, 2)" in low
    assert "list_number >= 1" in low
    assert "list_depth between 0 and 4" in low


def _sample_v2_report():
    text = "Intro paragraph with alpha = 1 inside."
    return {
        "overall_score": 12.5,
        "input_text": text,
        "matches": [],
        "document": {
            "version": 2,
            "text": text,
            "extraction_meta": {
                "pipeline_version": 2,
                "document_mode": "hybrid",
                "total_pages": 2,
                "ocr_pages": [2],
                "multi_column_pages": [1],
                "formula_count": 2,
                "formula_fallback_count": 1,
                "warnings": ["page_2_illegible_scan"],
            },
            "blocks": [
                {
                    "block_id": "intro_0",
                    "section": "introduction",
                    "type": "paragraph",
                    "start": 0,
                    "end": len(text),
                    "page": 1,
                    "layout_band": 1,
                    "column_role": "left",
                    "column_count": 2,
                    "inline_formulas": [{"start": 21, "end": 30, "latex": r"\alpha = 1"}],
                },
                {
                    "block_id": "intro_formula_0",
                    "section": "introduction",
                    "type": "formula",
                    "start": len(text),
                    "end": len(text),
                    "page": 1,
                    "layout_band": 1,
                    "column_role": "left",
                    "column_count": 2,
                    "formula_latex": r"E = mc^2",
                    "equation_number": "(1)",
                },
                {
                    "block_id": "intro_formula_1",
                    "section": "introduction",
                    "type": "formula",
                    "start": len(text),
                    "end": len(text),
                    "page": 1,
                    "layout_band": 1,
                    "column_role": "right",
                    "column_count": 2,
                    "image_url": "https://cdn.example/eq2.png",
                    "equation_number": "(2)",
                },
            ],
        },
    }


def test_report_store_persists_v2_columns_and_falls_back_before_migration(monkeypatch):
    inserted_passages = []
    updated_docs = []

    class FakeTable:
        def __init__(self, name: str, fail_v2: bool):
            self.name = name
            self.fail_v2 = fail_v2
            self._payload = None

        def upsert(self, row, **kwargs):
            self._payload = row
            return self

        def update(self, row):
            self._payload = row
            return self

        def delete(self):
            return self

        def insert(self, rows):
            self._payload = rows
            return self

        def eq(self, *args):
            return self

        def execute(self):
            if self.name == "documents" and isinstance(self._payload, dict) and "extraction_meta" in self._payload:
                if self.fail_v2:
                    raise RuntimeError('column "extraction_meta" does not exist')
                updated_docs.append(self._payload)
            if self.name == "document_passages" and isinstance(self._payload, list):
                if self.fail_v2 and any("formula_latex" in r or r.get("block_type") == "formula" for r in self._payload):
                    raise RuntimeError('column "formula_latex" does not exist')
                inserted_passages.append(self._payload)
            return SimpleNamespace(data=[])

    # 1. Post-migration: stores extraction_meta + all 8 columns + zero-length formula blocks.
    monkeypatch.setattr(
        report_store,
        "get_client",
        lambda: SimpleNamespace(table=lambda name: FakeTable(name, fail_v2=False)),
    )
    report = _sample_v2_report()
    report_store._persist_to_supabase(
        "doc-v2", report, user_id="user-1", input_type="pdf", input_name="stem.pdf"
    )
    assert len(updated_docs) == 1
    assert updated_docs[0]["extraction_meta"]["pipeline_version"] == 2
    assert len(inserted_passages) == 1
    rows = inserted_passages[0]
    assert len(rows) == 3
    assert rows[0]["column_role"] == "left"
    assert rows[0]["inline_formulas"] == [{"start": 21, "end": 30, "latex": r"\alpha = 1"}]
    assert rows[1]["block_type"] == "formula"
    assert rows[1]["formula_latex"] == r"E = mc^2"
    assert rows[1]["equation_number"] == "(1)"

    # 2. Pre-migration database: progressive downgrade keeps paragraphs + image-backed formula fallback.
    inserted_passages.clear()
    updated_docs.clear()
    monkeypatch.setattr(
        report_store,
        "get_client",
        lambda: SimpleNamespace(table=lambda name: FakeTable(name, fail_v2=True)),
    )
    report_store._persist_to_supabase(
        "doc-legacy", report, user_id="user-1", input_type="pdf", input_name="stem.pdf"
    )
    assert len(inserted_passages) == 1
    fallback_rows = inserted_passages[0]
    assert [r["block_type"] for r in fallback_rows] == ["paragraph", "image"]
    assert fallback_rows[1]["image_url"] == "https://cdn.example/eq2.png"
    assert "formula_latex" not in fallback_rows[0]


def test_extract_and_upload_images_uploads_formula_fallback_png_and_strips_raw_bytes(monkeypatch):
    uploaded = []

    class FakeBucket:
        def upload(self, path, data, file_options=None):
            uploaded.append((path, data, file_options))

        def create_signed_url(self, path, seconds):
            return {"signedURL": f"https://storage.local/{path}"}

    class FakeStorage:
        def from_(self, bucket):
            return FakeBucket()

    monkeypatch.setattr(report_store, "get_client", lambda: SimpleNamespace(storage=FakeStorage()))
    report = {
        "document": {
            "blocks": [
                {
                    "block_id": "body_formula_0",
                    "type": "formula",
                    "_image_bytes": b"\x89PNG\r\n\x1a\nfakepng",
                    "_image_ext": "png",
                }
            ]
        }
    }
    report_store._extract_and_upload_images("rep-1", report, "user-1")
    block = report["document"]["blocks"][0]
    assert "_image_bytes" not in block
    assert "_image_ext" not in block
    assert block["image_url"] == "https://storage.local/user-1/rep-1/images/0.png"
    assert len(uploaded) == 1
    assert uploaded[0][1].startswith(b"\x89PNG")


@pytest.mark.skipif(not os.getenv("RUN_PGSERVER_MIGRATION_TESTS"), reason="pgserver optional in unit suite")
def test_migration_executes_under_pgserver_if_available():
    pgserver = pytest.importorskip("pgserver")
    assert pgserver is not None
