import os
import re
import json
import time
import hashlib
import sqlite3
import requests
from urllib.parse import urlparse
from extractor import extract_sections_from_pdf

CACHE_DIR = "paper_cache"

PDF_DIR = os.path.join(CACHE_DIR, "pdf")
SECTIONS_DIR = os.path.join(CACHE_DIR, "sections")
CHUNKS_DIR = os.path.join(CACHE_DIR, "chunks")
DB_PATH = os.path.join(CACHE_DIR, "papers.db")


def init_cache():
    os.makedirs(PDF_DIR, exist_ok=True)
    os.makedirs(SECTIONS_DIR, exist_ok=True)
    os.makedirs(CHUNKS_DIR, exist_ok=True)

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    cur.execute("""
    CREATE TABLE IF NOT EXISTS papers (
        paper_id TEXT PRIMARY KEY,
        title TEXT,
        year TEXT,
        doi TEXT,
        arxiv_id TEXT,
        source TEXT,
        url TEXT,
        pdf_url TEXT,
        pdf_path TEXT,
        sections_path TEXT,
        downloaded INTEGER DEFAULT 0,
        created_at TEXT
    )
    """)

    conn.commit()
    conn.close()


def normalize_title(title):
    title = title or ""
    title = title.lower()
    title = re.sub(r"[^a-z0-9\s]", " ", title)
    title = re.sub(r"\s+", " ", title)
    return title.strip()


def extract_arxiv_id(url):
    if not url:
        return ""

    match = re.search(r"arxiv\.org/(abs|pdf)/([\d\.]+)", url)

    if match:
        return match.group(2).replace(".pdf", "")

    return ""


def make_paper_id(paper):
    doi = paper.get("doi") or ""

    if doi:
        return "doi_" + hashlib.sha1(doi.lower().encode()).hexdigest()

    arxiv_id = paper.get("arxiv_id") or extract_arxiv_id(paper.get("url", "")) or extract_arxiv_id(paper.get("pdf_url", ""))

    if arxiv_id:
        return "arxiv_" + arxiv_id.replace("/", "_").replace(".", "_")

    title = normalize_title(paper.get("title", ""))

    return "title_" + hashlib.sha1(title.encode()).hexdigest()


def paper_exists(paper_id):
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    cur.execute(
        "SELECT paper_id, pdf_path, downloaded FROM papers WHERE paper_id = ?",
        (paper_id,)
    )

    row = cur.fetchone()
    conn.close()

    return row


def guess_pdf_url(paper):
    pdf_url = paper.get("pdf_url") or ""

    if pdf_url:
        return pdf_url

    url = paper.get("url") or ""

    if "arxiv.org/abs/" in url:
        return url.replace("/abs/", "/pdf/") + ".pdf"

    if "arxiv.org/pdf/" in url:
        return url

    return ""


def find_pdf_url_in_html(html_text, base_url=""):
    """
    Nhiều trang học thuật (arXiv, ACL Anthology, OpenReview, MDPI, Springer...)
    nhúng sẵn <meta name="citation_pdf_url" content="..."> trong trang abstract/HTML.
    Dùng nó như phương án dự phòng khi link PDF đoán ban đầu không tải được.
    """
    match = re.search(
        r'<meta[^>]+name=["\']citation_pdf_url["\'][^>]+content=["\']([^"\']+)["\']',
        html_text,
        re.IGNORECASE
    )

    if not match:
        match = re.search(
            r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']citation_pdf_url["\']',
            html_text,
            re.IGNORECASE
        )

    if not match:
        return ""

    found_url = match.group(1).strip()

    if found_url.startswith("//"):
        found_url = "https:" + found_url
    elif found_url.startswith("/") and base_url:
        parsed = urlparse(base_url)
        found_url = f"{parsed.scheme}://{parsed.netloc}{found_url}"

    return found_url


def download_pdf(pdf_url, save_path, timeout=30, paper_page_url=""):
    if not pdf_url:
        pdf_url = ""

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0 Safari/537.36"
        )
    }

    def try_fetch(url):
        try:
            resp = requests.get(
                url,
                headers=headers,
                timeout=timeout,
                allow_redirects=True
            )
            return resp
        except Exception as e:
            print(f"  [download error] {e} - {url}")
            return None

    candidates_tried = []

    if pdf_url:
        candidates_tried.append(pdf_url)

    for attempt_url in list(candidates_tried):
        response = try_fetch(attempt_url)

        if response is None:
            continue

        if response.status_code != 200:
            print(f"  [download fail] HTTP {response.status_code} - {attempt_url}")
            continue

        content_type = response.headers.get("content-type", "").lower()
        is_pdf = "pdf" in content_type or attempt_url.lower().endswith(".pdf")

        if is_pdf:
            with open(save_path, "wb") as f:
                f.write(response.content)

            if os.path.getsize(save_path) < 10_000:
                print(f"  [download fail] file too small (<10KB) - {attempt_url}")
                os.remove(save_path)
                continue

            return True

        # Không phải PDF -> thử tìm citation_pdf_url trong HTML trả về.
        if "html" in content_type:
            recovered_url = find_pdf_url_in_html(response.text, base_url=attempt_url)

            if recovered_url and recovered_url not in candidates_tried:
                print(f"  [recovered pdf link from meta tag] {recovered_url}")
                candidates_tried.append(recovered_url)

    # Nếu vẫn chưa ra, thử luôn trang abstract gốc (paper_page_url) để tìm meta tag.
    if paper_page_url and paper_page_url not in candidates_tried:
        response = try_fetch(paper_page_url)

        if response and response.status_code == 200:
            content_type = response.headers.get("content-type", "").lower()

            if "html" in content_type:
                recovered_url = find_pdf_url_in_html(response.text, base_url=paper_page_url)

                if recovered_url:
                    print(f"  [recovered pdf link from abstract page] {recovered_url}")
                    final_response = try_fetch(recovered_url)

                    if final_response and final_response.status_code == 200:
                        final_content_type = final_response.headers.get("content-type", "").lower()

                        if "pdf" in final_content_type or recovered_url.lower().endswith(".pdf"):
                            with open(save_path, "wb") as f:
                                f.write(final_response.content)

                            if os.path.getsize(save_path) >= 10_000:
                                return True

                            os.remove(save_path)

    return False


def save_paper_record(paper, paper_id, pdf_url="", pdf_path="", downloaded=False):
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    sections_path = os.path.join(SECTIONS_DIR, paper_id + ".json")

    cur.execute("""
    INSERT OR REPLACE INTO papers (
        paper_id,
        title,
        year,
        doi,
        arxiv_id,
        source,
        url,
        pdf_url,
        pdf_path,
        sections_path,
        downloaded,
        created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        paper_id,
        paper.get("title", ""),
        str(paper.get("year", "")),
        paper.get("doi", ""),
        paper.get("arxiv_id", "") or extract_arxiv_id(paper.get("url", "")),
        paper.get("source", ""),
        paper.get("url", ""),
        pdf_url,
        pdf_path,
        sections_path,
        1 if downloaded else 0,
        time.strftime("%Y-%m-%d %H:%M:%S")
    ))

    conn.commit()
    conn.close()

def cache_candidate_paper(paper):
    init_cache()

    paper_id = make_paper_id(paper)
    existing = paper_exists(paper_id)

    if existing:
        return {
            "paper_id": paper_id,
            "status": "exists",
            "pdf_path": existing[1],
            "downloaded": bool(existing[2])
        }

    pdf_url = guess_pdf_url(paper)
    pdf_path = os.path.join(PDF_DIR, paper_id + ".pdf")

    downloaded = download_pdf(pdf_url, pdf_path, paper_page_url=paper.get("url", ""))

    if not downloaded:
        pdf_path = ""

    save_paper_record(
        paper=paper,
        paper_id=paper_id,
        pdf_url=pdf_url,
        pdf_path=pdf_path,
        downloaded=downloaded
    )

    return {
        "paper_id": paper_id,
        "status": "downloaded" if downloaded else "metadata_only",
        "pdf_url": pdf_url,
        "pdf_path": pdf_path,
        "downloaded": downloaded
    }

def build_fallback_chunks_from_abstract(paper_id, title, abstract, chunk_size=900, overlap=150):
    """
    Dùng khi KHÔNG tải được PDF. Tạo chunk trực tiếp từ title+abstract
    (dữ liệu đã có sẵn từ search_all_sources) để vẫn có gì đó để so khớp,
    thay vì bỏ trắng hoàn toàn paper này.
    """
    text = (title + "\n" + (abstract or "")).strip()

    if len(text) < 50:
        return {
            "paper_id": paper_id,
            "sections_built": False,
            "chunks_built": False,
            "reason": "no_abstract_text"
        }

    chunks = []
    start = 0

    while start < len(text):
        end = start + chunk_size
        chunk_text = text[start:end].strip()

        if len(chunk_text) >= 40:
            chunks.append({
                "paper_id": paper_id,
                "section": "abstract",
                "chunk_id": f"{paper_id}_abstract_{len(chunks)}",
                "start_char": start,
                "end_char": min(end, len(text)),
                "text": chunk_text
            })

        start += chunk_size - overlap

    chunks_path = os.path.join(CHUNKS_DIR, paper_id + ".json")

    with open(chunks_path, "w", encoding="utf-8") as f:
        json.dump(chunks, f, ensure_ascii=False, indent=2)

    return {
        "paper_id": paper_id,
        "sections_built": False,
        "chunks_built": True,
        "chunks_path": chunks_path,
        "num_chunks": len(chunks),
        "chunks_source": "abstract_fallback"
    }


def cache_candidate_papers(candidate_papers, top_k=10, build_text=True):
    init_cache()

    cached = []

    for paper in candidate_papers[:top_k]:
        result = cache_candidate_paper(paper)

        # đảm bảo luôn có thông tin nguồn cho report/frontend
        result["title"] = result.get("title") or paper.get("title", "")
        result["url"] = result.get("url") or paper.get("url", "")
        result["pdf_url"] = result.get("pdf_url") or guess_pdf_url(paper)

        if build_text and result.get("downloaded") and result.get("pdf_path"):
            build_result = build_sections_and_chunks_for_paper(
                paper_id=result["paper_id"],
                pdf_path=result["pdf_path"]
            )
            result.update(build_result)
        elif build_text:
            # Không tải được PDF -> fallback dùng abstract để vẫn so khớp được.
            fallback_result = build_fallback_chunks_from_abstract(
                paper_id=result["paper_id"],
                title=result.get("title", ""),
                abstract=paper.get("abstract", "")
            )
            result.update(fallback_result)

        cached.append(result)

        print(
            result["status"],
            "|",
            result.get("title", "")[:80],
            "|",
            result.get("pdf_path", ""),
            "| chunks:",
            result.get("num_chunks", 0)
        )

    return cached


def build_sections_and_chunks_for_paper(paper_id, pdf_path, chunk_size=900, overlap=150):
    if not pdf_path or not os.path.exists(pdf_path):
        return {
            "paper_id": paper_id,
            "sections_built": False,
            "chunks_built": False,
            "reason": "missing_pdf"
        }

    sections = extract_sections_from_pdf(pdf_path)

    sections_path = os.path.join(SECTIONS_DIR, paper_id + ".json")
    chunks_path = os.path.join(CHUNKS_DIR, paper_id + ".json")

    with open(sections_path, "w", encoding="utf-8") as f:
        json.dump(sections, f, ensure_ascii=False, indent=2)

    chunks = []

    for section_name, section_text in sections.items():
        if section_name == "title":
            continue

        if not section_text or len(section_text.strip()) < 50:
            continue

        start = 0
        text = section_text.strip()

        while start < len(text):
            end = start + chunk_size
            chunk_text = text[start:end].strip()

            if len(chunk_text) >= 80:
                chunks.append({
                    "paper_id": paper_id,
                    "section": section_name,
                    "chunk_id": f"{paper_id}_{section_name}_{len(chunks)}",
                    "start_char": start,
                    "end_char": min(end, len(text)),
                    "text": chunk_text
                })

            start += chunk_size - overlap

    with open(chunks_path, "w", encoding="utf-8") as f:
        json.dump(chunks, f, ensure_ascii=False, indent=2)

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    cur.execute("""
    UPDATE papers
    SET sections_path = ?
    WHERE paper_id = ?
    """, (
        sections_path,
        paper_id
    ))

    conn.commit()
    conn.close()

    return {
        "paper_id": paper_id,
        "sections_built": True,
        "chunks_built": True,
        "sections_path": sections_path,
        "chunks_path": chunks_path,
        "num_chunks": len(chunks)
    }