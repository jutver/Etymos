"""Tests for backend/pdf_export.py covering original, edited layout reconstruction, and report appendix."""

from __future__ import annotations

import pymupdf

import pdf_export


def _make_sample_pdf(paragraphs: list[str], *, two_column: bool = False, with_image: bool = False) -> bytes:
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    if with_image:
        # Draw a solid vector/pixmap rectangle to ensure non-text artwork survives redaction
        page.draw_rect(pymupdf.Rect(50, 40, 150, 90), color=(0.1, 0.3, 0.7), fill=(0.2, 0.4, 0.8))

    y = 110.0
    for idx, text in enumerate(paragraphs):
        if two_column:
            col_x = 50.0 if idx % 2 == 0 else 310.0
            rect = pymupdf.Rect(col_x, y, col_x + 235.0, y + 85.0)
            if idx % 2 == 1:
                y += 95.0
        else:
            rect = pymupdf.Rect(50.0, y, 545.0, y + 60.0)
            y += 72.0
        page.insert_htmlbox(rect, f"<p>{text}</p>", css="p { font-family: sans-serif; font-size: 10.5pt; margin: 0; }")

    data = doc.tobytes()
    doc.close()
    return data


def _sample_report() -> dict:
    return {
        "overall_score": 34.5,
        "input_text": "First original paragraph about neural networks.\n\nSecond original paragraph about plagiarism detection.",
        "ai_detection": {"ai_score": 18.0},
        "published_paper_match": {
            "title": "ViHateT5: Enhancing Hate Speech Detection",
            "match_percent": 68.0,
        },
        "matched_papers": [
            {
                "source_paper_id": "arxiv:2405.14141",
                "source_title": "ViHateT5: Enhancing Hate Speech Detection",
                "source_kind": "academic",
                "match_percent": 24.5,
                "authors": ["Nguyen Van A", "Tran Thi B"],
                "year": 2024,
                "venue": "ACL",
                "doi": "10.18653/v1/2024.acl-1",
                "url": "https://arxiv.org/abs/2405.14141",
            },
            {
                "source_paper_id": "web-1",
                "source_title": "Example Blog Post",
                "source_kind": "web",
                "match_percent": 10.0,
                "url": "https://example.com/post",
            },
        ],
        "matches": [
            {
                "source_paper_id": "arxiv:2405.14141",
                "input_sentence": "First original paragraph about neural networks.",
                "source_sentence": "Neural networks enhance hate speech detection.",
                "semantic_similarity": 0.92,
                "reason": "High semantic overlap",
            }
        ],
    }


def test_original_pdf_export_preserves_pages_and_appends_report():
    orig_bytes = _make_sample_pdf(["First original paragraph.", "Second original paragraph."], with_image=True)
    report = _sample_report()
    ctx = pdf_export.build_export_context(
        report_id="rep-1",
        title="Nghiên cứu Tiếng Việt",
        report=report,
        version_kind="original",
        lang="vi",
    )
    out = pdf_export.generate_export_pdf(
        context=ctx,
        original_pdf_bytes=orig_bytes,
        original_text=report["input_text"],
    )

    doc = pymupdf.open(stream=out, filetype="pdf")
    assert len(doc) >= 2
    assert "First original paragraph." in doc[0].get_text()
    appendix_text = "\n".join(doc[i].get_text() for i in range(1, len(doc)))
    assert "34.5%" in appendix_text
    assert "18.0%" in appendix_text
    assert "ViHateT5: Enhancing Hate Speech Detection" in appendix_text
    assert "Nguyen Van A" in appendix_text
    assert "https://example.com/post" in appendix_text
    assert "High semantic overlap" in appendix_text
    doc.close()


def test_edited_pdf_reconstructs_in_place_preserving_artwork_and_columns():
    p1 = "First original paragraph about neural networks."
    p2 = "Second original paragraph about plagiarism detection."
    orig_bytes = _make_sample_pdf([p1, p2], two_column=True, with_image=True)
    report = _sample_report()
    edited_html = (
        "<p>First rewritten paragraph about deep learning<sup class='badge'>1</sup>.</p>"
        f"<p>{p2}</p>"
    )
    ctx = pdf_export.build_export_context(
        report_id="rep-2",
        title="Two Column Paper",
        report=report,
        version_kind="saved",
        version_label="Version 1",
        edited_html=edited_html,
        lang="en",
    )
    out = pdf_export.generate_export_pdf(
        context=ctx,
        original_pdf_bytes=orig_bytes,
        original_text=f"{p1}\n\n{p2}",
        edited_html=edited_html,
    )

    doc = pymupdf.open(stream=out, filetype="pdf")
    page0_text = " ".join(doc[0].get_text().split())
    assert "First rewritten paragraph about deep learning." in page0_text
    assert "First original paragraph" not in page0_text
    assert p2 in page0_text
    # Artwork/drawings on page 0 remain intact
    assert len(doc[0].get_drawings()) >= 1
    assert doc[0].rect == pymupdf.Rect(0, 0, 595, 842)
    doc.close()


def test_edited_pdf_long_rewrite_creates_continuation_without_clipping():
    p1 = "Short original sentence."
    p2 = "Untouched second paragraph directly below."
    orig_bytes = _make_sample_pdf([p1, p2])
    long_rewrite = " ".join(["This is a much longer rewritten academic sentence with Vietnamese diacritics Tiếng Việt."] * 25)
    edited_html = f"<p>{long_rewrite}</p><p>{p2}</p>"
    report = _sample_report()
    ctx = pdf_export.build_export_context(
        report_id="rep-3",
        title="Long Rewrite",
        report=report,
        version_kind="draft",
        version_label="Current Draft",
        edited_html=edited_html,
        lang="en",
    )
    out = pdf_export.generate_export_pdf(
        context=ctx,
        original_pdf_bytes=orig_bytes,
        original_text=f"{p1}\n\n{p2}",
        edited_html=edited_html,
    )
    doc = pymupdf.open(stream=out, filetype="pdf")
    # Continuation page inserted so body spans >= 2 pages before appendix
    assert len(doc) >= 3
    full_body = doc[0].get_text() + "\n" + doc[1].get_text()
    assert "Tiếng Việt" in full_body
    assert p2 in doc[0].get_text()
    doc.close()


def test_fallback_html_reconstruction_and_zero_matches():
    report = {"overall_score": 0.0, "input_text": "Plain text", "matched_papers": [], "matches": []}
    edited_html = "<h1>Tiêu đề Tiếng Việt</h1><p>Đoạn văn bản đã chỉnh sửa.</p><ul><li>Mục một</li></ul>"
    ctx = pdf_export.build_export_context(
        report_id="rep-4",
        title="Pasted Doc",
        report=report,
        version_kind="saved",
        edited_html=edited_html,
        lang="vi",
    )
    out = pdf_export.generate_export_pdf(
        context=ctx,
        original_pdf_bytes=None,
        original_text="Plain text",
        edited_html=edited_html,
    )
    doc = pymupdf.open(stream=out, filetype="pdf")
    full_text = "\n".join(doc[i].get_text() for i in range(len(doc)))
    assert "Tiêu đề Tiếng Việt" in full_text
    assert "Mục một" in full_text
    assert "Không phát hiện nguồn trùng khớp" in full_text
    doc.close()


def test_multi_page_appendix_pagination_with_many_sources():
    report = {
        "overall_score": 45.0,
        "input_text": "Sample text",
        "matched_papers": [
            {
                "source_paper_id": f"src-{i}",
                "source_title": f"Academic Paper Number {i} on Machine Learning",
                "source_kind": "academic",
                "match_percent": 15.0,
                "authors": ["Author A", "Author B"],
                "year": 2024,
                "url": f"https://example.org/paper/{i}",
            }
            for i in range(1, 16)
        ],
        "matches": [],
    }
    ctx = pdf_export.build_export_context(
        report_id="rep-5",
        title="Many Sources",
        report=report,
        version_kind="original",
        lang="en",
    )
    appendix = pdf_export.render_report_appendix_pdf(ctx)
    assert len(appendix) >= 2
    last_text = appendix[-1].get_text()
    assert "Academic Paper Number 15" in last_text
    appendix.close()


def test_export_pdf_endpoint_returns_attachment_and_validates_edited_html(monkeypatch):
    from fastapi.testclient import TestClient
    import api.app as api_app
    from auth import AuthedUser, verify_supabase_jwt

    sample_report = _sample_report()
    sample_report["user_id"] = "user-123"
    sample_report["file_name"] = "Thesis Draft.pdf"
    orig_bytes = _make_sample_pdf(["First original paragraph about neural networks."])

    monkeypatch.setattr(api_app, "get_report", lambda rid: sample_report if rid == "rep-api-1" else None)
    monkeypatch.setattr(api_app, "load_original_pdf_bytes", lambda rid, uid: orig_bytes)
    monkeypatch.setattr(api_app, "original_text", lambda rid, fallback="": fallback)
    api_app.app.dependency_overrides[verify_supabase_jwt] = lambda: AuthedUser(
        user_id="user-123", email="test@example.com", role="authenticated", is_admin=False
    )

    try:
        client = TestClient(api_app.app)
        resp_bad = client.post(
            "/api/reports/rep-api-1/export-pdf",
            json={"version_kind": "saved", "lang": "en"},
        )
        assert resp_bad.status_code == 400

        resp_ok = client.post(
            "/api/reports/rep-api-1/export-pdf",
            json={
                "version_kind": "saved",
                "version_label": "Version 2",
                "edited_html": "<p>Rewritten thesis paragraph.</p>",
                "lang": "vi",
            },
        )
        assert resp_ok.status_code == 200
        assert resp_ok.headers["content-type"] == "application/pdf"
        assert "Thesis_Draft_pdf-report.pdf" in resp_ok.headers["content-disposition"]
        doc = pymupdf.open(stream=resp_ok.content, filetype="pdf")
        assert len(doc) >= 2
        assert "Rewritten thesis paragraph." in doc[0].get_text()
        doc.close()
    finally:
        api_app.app.dependency_overrides.clear()
