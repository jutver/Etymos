"""Comprehensive tests for backend/pdf_export.py and POST /api/reports/{id}/export-pdf."""

from __future__ import annotations

import pymupdf

import pdf_export


def _make_sample_pdf(
    paragraphs: list[str],
    *,
    two_column: bool = False,
    with_image: bool = False,
) -> bytes:
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    if with_image:
        page.draw_rect(pymupdf.Rect(50, 40, 150, 90), color=(0.1, 0.3, 0.7), fill=(0.2, 0.4, 0.8))

    archive, font_css = pdf_export._open_font_archive()
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
        css = f'{font_css}\np {{ font-family: "EtymosSans", sans-serif; font-size: 10.5pt; margin: 0; }}'
        page.insert_htmlbox(rect, f"<p>{text}</p>", css=css, archive=archive)

    data = doc.tobytes()
    doc.close()
    return data


def _sample_report() -> dict:
    return {
        "overall_score": 34.5,
        "input_text": "First original paragraph about neural networks.\n\nSecond original paragraph about plagiarism detection.",
        "ai_detection": {"available": True, "overall_score": 18.0, "level": "low"},
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
                "explanation": "High semantic overlap",
            }
        ],
    }


def _collect_highlight_fills(page: pymupdf.Page) -> list[tuple]:
    fills = []
    for d in page.get_drawings():
        op = d.get("fill_opacity")
        fill = d.get("fill")
        if fill is not None and op is not None and 0.05 <= float(op) <= 0.35:
            fills.append((fill, round(float(op), 2)))
    return fills


def test_vietnamese_appendix_embeds_single_unified_font_family():
    report = _sample_report()
    ctx = pdf_export.build_export_context(
        report_id="rep-font-1",
        title="Nghiên cứu Tiếng Việt",
        report=report,
        version_kind="original",
        version_label="Original Document",
        lang="vi",
    )
    appendix = pdf_export.render_report_appendix_pdf(ctx)
    font_names = [f[3] for f in appendix[0].get_fonts()]
    assert font_names
    assert not any("Nimbus" in name or "Noto Serif" in name for name in font_names)
    assert any("Be Vietnam Pro" in name for name in font_names)
    text = appendix[0].get_text()
    assert "Nghiên cứu Tiếng Việt" in text
    assert "Tài liệu gốc" in text
    assert "Báo cáo Kiểm tra Tương đồng & Nội dung AI" in text
    appendix.close()


def test_original_pdf_export_overlays_color_highlights_and_omits_reason_clutter():
    s1 = "First original paragraph about neural networks."
    s2 = "Second original paragraph about plagiarism detection."
    orig_bytes = _make_sample_pdf([s1, s2], with_image=True)

    # Locate exact rect for s1 to simulate backend pdf_rects alongside text-search fallback for s2
    probe = pymupdf.open(stream=orig_bytes, filetype="pdf")
    s1_hits = probe[0].search_for(s1)
    assert s1_hits
    s1_rect = s1_hits[0]
    probe.close()

    report = _sample_report()
    report["matches"] = [
        {
            "source_paper_id": "arxiv:2405.14141",
            "source_title": "ViHateT5: Enhancing Hate Speech Detection",
            "input_sentence": s1,
            "source_sentence": "Neural networks enhance hate speech detection.",
            "semantic_similarity": 0.94,
            "explanation": "Should NOT appear in appended report",
            "pdf_rects": [
                {"page": 1, "x0": s1_rect.x0, "y0": s1_rect.y0, "x1": s1_rect.x1, "y1": s1_rect.y1}
            ],
        },
        {
            "source_paper_id": "web-1",
            "source_title": "Example Blog Post",
            "source_kind": "web",
            "input_sentence": s2,
            "source_sentence": "Plagiarism detection benchmark overview.",
            "semantic_similarity": 0.90,
            "explanation": "Another verbose explanation that must be omitted",
        },
    ]

    ctx = pdf_export.build_export_context(
        report_id="rep-1",
        title="Nghiên cứu Tiếng Việt",
        report=report,
        version_kind="original",
        version_label="Original Document",
        lang="vi",
    )
    out = pdf_export.generate_export_pdf(
        context=ctx,
        original_pdf_bytes=orig_bytes,
        original_text=report["input_text"],
    )

    doc = pymupdf.open(stream=out, filetype="pdf")
    assert len(doc) >= 2
    assert s1 in doc[0].get_text()
    assert s2 in doc[0].get_text()

    # Original artwork (1 filled rect at opacity 1) + 2 distinct translucent highlights + bottom underlines
    fills = _collect_highlight_fills(doc[0])
    assert len(fills) >= 2
    distinct_colors = {tuple(round(c, 3) for c in fill) for fill, _ in fills}
    assert len(distinct_colors) == 2

    appendix_text = "\n".join(doc[i].get_text() for i in range(1, len(doc)))
    assert "Tài liệu gốc" in appendix_text
    assert "34.5%" in appendix_text
    assert "18.0%" in appendix_text
    assert "24.5%" in appendix_text
    assert "10.0%" in appendix_text
    assert "ViHateT5: Enhancing Hate Speech Detection" in appendix_text
    assert "https://example.com/post" in appendix_text
    # "Why it is flagged" explanations must be completely removed
    assert "Lý do đánh dấu" not in appendix_text
    assert "Match reason" not in appendix_text
    assert "Should NOT appear" not in appendix_text
    assert "Another verbose explanation" not in appendix_text
    doc.close()


def test_cross_source_overlapping_rects_are_deduplicated():
    s1 = "Shared overlapping passage between two matched sources."
    orig_bytes = _make_sample_pdf([s1])
    rect = {"page": 1, "x0": 50.0, "y0": 110.0, "x1": 350.0, "y1": 124.0}
    report = {
        "overall_score": 40.0,
        "input_text": s1,
        "matched_papers": [
            {"source_paper_id": "s-1", "source_title": "Primary Source", "match_percent": 30.0},
            {"source_paper_id": "s-2", "source_title": "Secondary Source", "match_percent": 10.0},
        ],
        "matches": [
            {"source_paper_id": "s-1", "input_sentence": s1, "semantic_similarity": 0.95, "pdf_rects": [rect]},
            {"source_paper_id": "s-2", "input_sentence": s1, "semantic_similarity": 0.89, "pdf_rects": [rect]},
        ],
    }
    ctx = pdf_export.build_export_context(
        report_id="rep-dedupe",
        title="Overlap Test",
        report=report,
        version_kind="original",
        lang="en",
    )
    out = pdf_export.generate_export_pdf(
        context=ctx,
        original_pdf_bytes=orig_bytes,
        original_text=s1,
    )
    doc = pymupdf.open(stream=out, filetype="pdf")
    # Only the higher-ranked source highlight should remain for identical overlapping coordinates
    fills = _collect_highlight_fills(doc[0])
    assert len(fills) == 1
    doc.close()


def test_supabase_reloaded_history_report_preserves_title_words_ai_and_percent():
    # Mirrors exact output of report_store.py:_fetch_from_supabase (after fix)
    reloaded_report = {
        "report_id": "rep-supa-1",
        "status": "completed",
        "title": "ViHateT5 Vietnamese Hate Speech Study.pdf",
        "file_name": "ViHateT5 Vietnamese Hate Speech Study.pdf",
        "word_count": 1420,
        "input": {"type": "pdf", "name": "ViHateT5 Vietnamese Hate Speech Study.pdf"},
        "overall_score": 91.9,
        "ai_detection": {"available": True, "overall_score": 22.4, "level": "low"},
        "published_paper_match": {
            "title": "ViHateT5: Enhancing Hate Speech Detection in Vietnamese",
            "match_percent": 91.9,
        },
        "matches": [
            {
                "id": f"m-{i}",
                "source_title": (
                    "ViHateT5: Enhancing Hate Speech Detection in ...ViHateT5: "
                    "Enhancing Hate Speech Detection in Vietnamese With ...(PDF) "
                    "ViHateT5: Enhancing Hate Speech Detection in Vietnamese With a ..."
                    "tarudesu/ViHateT5-base-HSD · Hugging FaceViHateT5 - Vietnamese Hate Speech Detection with T5"
                ),
                "source_author": "Luan Thanh Nguyen, Kiet Van Nguyen",
                "source_kind": "academic",
                "match_percent": 94.5,
                "user_snippet": f"Matched academic sentence number {i} from the paper.",
                "source_url": "https://arxiv.org/abs/2405.14141",
                "explanation": "This sentence is identical to the source...",
            }
            for i in range(1, 51)
        ],
    }

    ctx = pdf_export.build_export_context(
        report_id="rep-supa-1",
        title="ViHateT5 Vietnamese Hate Speech Study.pdf",
        report=reloaded_report,
        version_kind="original",
        version_label="Original Document",
        lang="vi",
    )

    assert ctx.title == "ViHateT5 Vietnamese Hate Speech Study.pdf"
    assert ctx.version_label == "Tài liệu gốc"
    assert ctx.word_count == 1420
    assert ctx.ai_available is True
    assert ctx.ai_score == 22.4
    assert len(ctx.matched_sources) == 1
    src = ctx.matched_sources[0]
    assert src.match_percent == 91.9
    assert src.match_count == 50
    assert "Hugging Face" not in src.title
    assert src.title.count("ViHateT5") == 1

    appendix = pdf_export.render_report_appendix_pdf(ctx)
    text = "\n".join(appendix[i].get_text() for i in range(len(appendix)))
    assert "ViHateT5 Vietnamese Hate Speech Study.pdf" in text
    assert "1,420" in text
    assert "22.4%" in text
    assert "Chưa khả dụng" not in text
    assert "91.9%" in text
    assert "0.0%" not in text
    assert "Lý do đánh dấu" not in text
    assert "This sentence is identical" not in text
    appendix.close()


def test_edited_pdf_reconstructs_in_place_preserving_artwork_and_filtering_stale_highlights():
    p1 = "First original paragraph about neural networks."
    p2 = "Second original paragraph about plagiarism detection."
    orig_bytes = _make_sample_pdf([p1, p2], two_column=True, with_image=True)
    report = {
        "overall_score": 34.5,
        "input_text": f"{p1}\n\n{p2}",
        "ai_detection": {"available": True, "overall_score": 18.0, "level": "low"},
        "matched_papers": [
            {"source_paper_id": "src-1", "source_title": "Neural Networks Paper", "match_percent": 18.0},
            {"source_paper_id": "src-2", "source_title": "Plagiarism Detection Paper", "match_percent": 16.5},
        ],
        "matches": [
            {"source_paper_id": "src-1", "input_sentence": p1, "semantic_similarity": 0.94},
            {"source_paper_id": "src-2", "input_sentence": p2, "semantic_similarity": 0.92},
        ],
    }
    edited_html = (
        "<p>Completely fresh rewritten introductory prose.<sup class='badge'>1</sup></p>"
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
    assert "Completely fresh rewritten introductory prose." in page0_text
    assert "First original paragraph" not in page0_text
    assert p2 in page0_text
    assert doc[0].rect == pymupdf.Rect(0, 0, 595, 842)
    # Only the untouched second paragraph (src-2 -> rose #e11d48) receives a translucent highlight
    fills = _collect_highlight_fills(doc[0])
    assert len(fills) >= 1
    src2_rgb = tuple(round(c, 2) for c in pdf_export.SOURCE_PALETTE[1].fill_rgb)
    assert all(tuple(round(c, 2) for c in fill) == src2_rgb for fill, _ in fills)
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
    assert len(doc) >= 3
    full_body = doc[0].get_text() + "\n" + doc[1].get_text()
    assert "Tiếng Việt" in full_body
    assert p2 in doc[0].get_text()
    doc.close()


def test_fallback_html_reconstruction_highlights_and_zero_matches():
    snippet = "Đoạn văn bản đã chỉnh sửa."
    report = {
        "overall_score": 25.0,
        "input_text": snippet,
        "matched_papers": [
            {"source_paper_id": "web-1", "source_title": "Vietnamese Corpus", "source_kind": "web", "match_percent": 25.0}
        ],
        "matches": [
            {"source_paper_id": "web-1", "input_sentence": snippet, "semantic_similarity": 0.91}
        ],
    }
    edited_html = f"<h1>Tiêu đề Tiếng Việt</h1><p>{snippet}</p><ul><li>Mục một</li></ul>"
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
        original_text=snippet,
        edited_html=edited_html,
    )
    doc = pymupdf.open(stream=out, filetype="pdf")
    full_text = "\n".join(doc[i].get_text() for i in range(len(doc)))
    assert "Tiêu đề Tiếng Việt" in full_text
    assert "Mục một" in full_text
    # Inline highlight fill should exist on body page
    assert any(d.get("fill") is not None for d in doc[0].get_drawings())
    doc.close()

    # Zero-match empty state
    empty_report = {"overall_score": 0.0, "input_text": "Plain clean text.", "matched_papers": [], "matches": []}
    empty_ctx = pdf_export.build_export_context(
        report_id="rep-empty",
        title="Clean Doc",
        report=empty_report,
        version_kind="original",
        lang="vi",
    )
    empty_out = pdf_export.generate_export_pdf(
        context=empty_ctx,
        original_pdf_bytes=None,
        original_text="Plain clean text.",
    )
    empty_doc = pymupdf.open(stream=empty_out, filetype="pdf")
    assert "Không phát hiện nguồn trùng khớp" in "\n".join(empty_doc[i].get_text() for i in range(len(empty_doc)))
    empty_doc.close()


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


def test_export_pdf_endpoint_returns_attachment_supports_document_title_and_supabase_passages(monkeypatch):
    from fastapi.testclient import TestClient
    import api.app as api_app
    from auth import AuthedUser, verify_supabase_jwt

    supa_report = {
        "report_id": "rep-api-1",
        "user_id": "user-123",
        "title": "Old Uploaded Filename.pdf",
        "file_name": "Old Uploaded Filename.pdf",
        "word_count": 320,
        "overall_score": 42.5,
        "ai_detection": {"available": True, "overall_score": 19.2, "level": "low"},
        "matches": [
            {
                "source_paper_id": "arxiv:2405.14141",
                "source_title": "Academic Paper Title",
                "source_kind": "academic",
                "match_percent": 92.0,
                "user_snippet": "First original paragraph about neural networks.",
                "source_url": "https://arxiv.org/abs/2405.14141",
            }
        ],
    }
    orig_bytes = _make_sample_pdf(["First original paragraph about neural networks."])

    monkeypatch.setattr(api_app, "get_report", lambda rid: supa_report if rid == "rep-api-1" else None)
    monkeypatch.setattr(api_app, "load_original_pdf_bytes", lambda rid, uid: orig_bytes)
    monkeypatch.setattr(api_app, "original_text", lambda rid, fallback="": fallback)
    monkeypatch.setattr(
        api_app,
        "fetch_passages",
        lambda rid: {"p1": {"text": "First original paragraph about neural networks."}},
    )
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
                "version_kind": "original",
                "version_label": "Original Document",
                "document_title": "Thesis Draft.pdf",
                "lang": "vi",
            },
        )
        assert resp_ok.status_code == 200
        assert resp_ok.headers["content-type"] == "application/pdf"
        assert "Thesis Draft - Etymos Report.pdf" in resp_ok.headers["content-disposition"]
        assert "Thesis%20Draft%20-%20Etymos%20Report.pdf" in resp_ok.headers["content-disposition"]
        doc = pymupdf.open(stream=resp_ok.content, filetype="pdf")
        assert len(doc) >= 2
        assert len(_collect_highlight_fills(doc[0])) >= 1
        app_text = "\n".join(doc[i].get_text() for i in range(1, len(doc)))
        assert "Thesis Draft.pdf" in app_text
        assert "Tài liệu gốc" in app_text
        assert "19.2%" in app_text
        assert "42.5%" in app_text
        assert "Lý do đánh dấu" not in app_text
        doc.close()
    finally:
        api_app.app.dependency_overrides.clear()


def test_safe_export_filename_format():
    import app as api_app

    assert api_app._safe_export_filename("Climate Paper.pdf") == "Climate Paper - Etymos Report.pdf"
    assert api_app._safe_export_filename("Draft/2026:v1.docx") == "Draft 2026 v1 - Etymos Report.pdf"
    assert api_app._safe_export_filename("") == "Etymos Report.pdf"
    assert api_app._safe_export_filename("Etymos Report") == "Etymos Report.pdf"
