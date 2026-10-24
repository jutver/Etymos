"""
The source-paper cache: every candidate paper a check finds is recorded once,
its PDF downloaded when there's an open-access link, and its text cut into the
chunks plagiarism_matcher compares against.

The records and chunks live in paper_store (Supabase in production, SQLite
locally), so they outlive the server. The local folders are only a working
copy: pdf/ keeps the downloaded PDFs (never uploaded anywhere), and
chunks/{paper_id}.json is filled from the store the first time a server needs
a paper's chunks.
"""
import os
import re
import json
import hashlib
import requests
from datetime import datetime, timezone
from urllib.parse import urlparse
from extractor import extract_sections_from_pdf, sentence_windows
import paper_store

CACHE_DIR = "paper_cache"

PDF_DIR = os.path.join(CACHE_DIR, "pdf")
SECTIONS_DIR = os.path.join(CACHE_DIR, "sections")
CHUNKS_DIR = os.path.join(CACHE_DIR, "chunks")
DB_PATH = os.path.join(CACHE_DIR, "papers.db")

# Bump when the chunking changes: a paper whose chunks are older is rebuilt
# the next time a check finds it, if this server still has its PDF.
CHUNK_VERSION = 2

# A paper whose PDF couldn't be downloaded gets another try after this many
# days even if no new link turned up: most failures are timeouts and rate
# limits, not papers that will never be reachable.
PDF_RETRY_DAYS = float(os.getenv("PDF_RETRY_DAYS", "7"))

_store = None


def get_store():
    global _store
    if _store is None:
        _store = paper_store.make_store(DB_PATH)
    return _store


def set_store(store):
    """Tests (and scripts) pick the store explicitly."""
    global _store
    _store = store


def init_cache():
    os.makedirs(PDF_DIR, exist_ok=True)
    os.makedirs(SECTIONS_DIR, exist_ok=True)
    os.makedirs(CHUNKS_DIR, exist_ok=True)


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


def guess_pdf_url(paper):
    pdf_url = paper.get("pdf_url") or ""

    if pdf_url:
        return pdf_url

    url = paper.get("url") or ""

    if "arxiv.org/abs/" in url:
        return url.replace("/abs/", "/pdf/") + ".pdf"

    if "arxiv.org/pdf/" in url:
        return url

    if paper.get("arxiv_id"):
        return f"https://arxiv.org/pdf/{paper['arxiv_id']}"

    if paper.get("acl_id"):
        return f"https://aclanthology.org/{paper['acl_id']}.pdf"

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



_STOPWORDS = frozenset("""
the and for with from that this these those into onto over under using use used
based via are was were has have had not but its their our your can may also than
then such each more most other which while where when what who how why all any
một các của và cho với trong được những này khi theo như là có không để từ trên
""".split())


def search_terms(queries, max_terms=40):
    """The distinct content words of a check's search queries, for searching
    the cached papers by title and abstract."""
    terms = []
    seen = set()

    for query in queries or []:
        for word in re.findall(r"[^\W_]{3,}", str(query).lower()):
            if word in _STOPWORDS or word.isdigit() or word in seen:
                continue
            seen.add(word)
            terms.append(word)

    return terms[:max_terms]


def paper_from_record(record):
    """A cached paper in the shape the search clients return, so it is ranked
    and cached like any other candidate."""
    return {
        "title": record.get("title") or "",
        "year": record.get("year") or "",
        "doi": record.get("doi") or "",
        "abstract": record.get("abstract") or "",
        "url": record.get("url") or "",
        "pdf_url": record.get("pdf_url") or "",
        "arxiv_id": record.get("arxiv_id") or "",
        "acl_id": record.get("acl_id") or "",
        "authors": record.get("authors") or [],
        "source": record.get("source") or "",
        "source_kind": record.get("source_kind") or "academic",
        "from_cache": True,
    }


def search_cached_papers(queries, limit=15):
    """Papers an earlier check already found that share words with this
    check's queries. They need no network to be compared, and they keep a
    known source from being missed when the search APIs are rate limited."""
    terms = search_terms(queries)

    if not terms:
        return []

    return [paper_from_record(record) for record in get_store().search(terms, limit)]


def find_open_access_pdf(paper):
    """A PDF link for a paper the search result gave none for, looked up by
    DOI. Empty when there is none or the lookup fails."""
    doi = paper.get("doi") or ""

    if not doi:
        return ""

    try:
        from search_paper.search_openalex import lookup_openalex_pdf_url
        return lookup_openalex_pdf_url(doi)
    except Exception as e:
        print(f"  [open access lookup error] {e} - {doi}")
        return ""


def _record_for(paper, paper_id, existing):
    """The paper's metadata merged over what is already cached: a later
    search result with fewer fields never blanks out an earlier one's."""
    old = existing or {}

    def pick(key, value):
        return value if value else (old.get(key) or "")

    title = pick("title", paper.get("title"))

    return {
        "paper_id": paper_id,
        "title": title,
        "normalized_title": normalize_title(title),
        "year": pick("year", str(paper.get("year") or "")),
        "doi": pick("doi", paper.get("doi")),
        "arxiv_id": pick("arxiv_id", paper.get("arxiv_id") or extract_arxiv_id(paper.get("url", ""))),
        "acl_id": pick("acl_id", paper.get("acl_id")),
        "source": pick("source", paper.get("source")),
        "source_kind": paper.get("source_kind") or old.get("source_kind") or "academic",
        "url": pick("url", paper.get("url")),
        "pdf_url": pick("pdf_url", guess_pdf_url(paper)),
        "authors": paper.get("authors") or old.get("authors") or [],
        "abstract": pick("abstract", paper.get("abstract")),
    }


def _changed(record, existing):
    return existing is None or any(record[k] != existing.get(k) for k in record)


def _attempt_is_stale(existing):
    attempted = paper_store.parse_time(existing.get("pdf_attempted_at"))

    if attempted is None:
        return True

    age = datetime.now(timezone.utc) - attempted
    return age.total_seconds() > PDF_RETRY_DAYS * 86400


_UNKNOWN = object()


def cache_candidate_paper(paper, existing=_UNKNOWN):
    init_cache()

    paper_id = make_paper_id(paper)
    store = get_store()

    if existing is _UNKNOWN:
        existing = store.get_many([paper_id]).get(paper_id)

    record = _record_for(paper, paper_id, existing)
    pdf_path = os.path.join(PDF_DIR, paper_id + ".pdf")
    has_local_pdf = os.path.exists(pdf_path)

    if existing and (existing.get("has_full_text") or has_local_pdf):
        # Full text already built (its chunks are in the store), or this
        # server still has the PDF to build it from.
        if _changed(record, existing):
            store.upsert(record)

        return {
            "paper_id": paper_id,
            "status": "exists",
            "pdf_path": pdf_path if has_local_pdf else "",
            "downloaded": True,
            "chunk_version": existing.get("chunk_version"),
        }

    pdf_url = guess_pdf_url(paper) or record["pdf_url"]

    # A paper cached without its PDF is tried again once a search turns up
    # a link it didn't have, or once the last attempt is old; the same
    # failing link isn't retried every check.
    if existing and not has_local_pdf:
        new_link = pdf_url and pdf_url != (existing.get("pdf_attempted_url") or "")

        if not new_link and not _attempt_is_stale(existing):
            if _changed(record, existing):
                store.upsert(record)

            return {
                "paper_id": paper_id,
                "status": "exists",
                "pdf_path": "",
                "downloaded": False
            }

    if not pdf_url:
        pdf_url = find_open_access_pdf(record)

    downloaded = has_local_pdf or download_pdf(pdf_url, pdf_path, paper_page_url=paper.get("url", ""))

    if not downloaded:
        pdf_path = ""

    record["pdf_url"] = pdf_url or record["pdf_url"]
    record["pdf_attempted_url"] = pdf_url or ""
    record["pdf_attempted_at"] = paper_store.now_iso()
    store.upsert(record)

    return {
        "paper_id": paper_id,
        "status": "downloaded" if downloaded else "metadata_only",
        "pdf_url": pdf_url,
        "pdf_path": pdf_path,
        "downloaded": downloaded
    }


def _write_local_chunks(paper_id, chunks):
    os.makedirs(CHUNKS_DIR, exist_ok=True)
    chunks_path = os.path.join(CHUNKS_DIR, paper_id + ".json")

    with open(chunks_path, "w", encoding="utf-8") as f:
        json.dump(chunks, f, ensure_ascii=False, indent=2)

    return chunks_path


def load_paper_chunks(paper_id):
    """A paper's chunks: this server's copy, else the store's (saved locally
    for next time). Empty when the paper has none anywhere."""
    chunks_path = os.path.join(CHUNKS_DIR, paper_id + ".json")

    if os.path.exists(chunks_path):
        with open(chunks_path, "r", encoding="utf-8") as f:
            return json.load(f)

    stored = get_store().load_chunks(paper_id)

    if not stored or not stored.get("chunks"):
        return []

    _write_local_chunks(paper_id, stored["chunks"])
    return stored["chunks"]


def ids_by_titles(titles):
    """{title: paper_id} for the titles that are cached."""
    wanted = {normalize_title(t): t for t in titles if t}
    found = get_store().ids_by_normalized_titles(list(wanted))
    return {wanted[key]: paper_id for key, paper_id in found.items() if key in wanted}


def build_fallback_chunks_from_abstract(paper_id, title, abstract, chunk_size=900, overlap=150, save=True):
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

    chunks_path = _write_local_chunks(paper_id, chunks)

    if save:
        get_store().save_chunks(paper_id, chunks, "abstract")

    return {
        "paper_id": paper_id,
        "sections_built": False,
        "chunks_built": True,
        "chunks_path": chunks_path,
        "num_chunks": len(chunks),
        "chunks_source": "abstract_fallback"
    }


def _full_text_chunks(result, existing):
    """Chunks for a paper whose full text is (or can be) available. Empty
    dict when there are none, so the caller falls back to the abstract."""
    paper_id = result["paper_id"]
    stale = (result.get("chunk_version") or 0) < CHUNK_VERSION

    if result.get("pdf_path") and (result["status"] != "exists" or stale or not (existing or {}).get("has_full_text")):
        built = build_sections_and_chunks_for_paper(paper_id=paper_id, pdf_path=result["pdf_path"])
        return built if built.get("num_chunks") else {}

    chunks = load_paper_chunks(paper_id)

    if not chunks:
        return {}

    return {
        "paper_id": paper_id,
        "sections_built": False,
        "chunks_built": True,
        "chunks_path": os.path.join(CHUNKS_DIR, paper_id + ".json"),
        "num_chunks": len(chunks),
        "chunks_source": "full_text"
    }


def cache_candidate_papers(candidate_papers, top_k=10, build_text=True):
    init_cache()

    papers = candidate_papers[:top_k]
    existing_by_id = get_store().get_many([make_paper_id(p) for p in papers])
    cached = []

    for paper in papers:
        existing = existing_by_id.get(make_paper_id(paper))
        result = cache_candidate_paper(paper, existing)

        # đảm bảo luôn có thông tin nguồn cho report/frontend
        result["title"] = result.get("title") or paper.get("title", "")
        result["url"] = result.get("url") or paper.get("url", "")
        result["pdf_url"] = result.get("pdf_url") or guess_pdf_url(paper)
        # Carried through to load_candidate_chunks/match_chunks/final report
        # so a match can be labeled "web" vs "academic" and (eventually)
        # rendered as a real citation instead of a raw internal id.
        result["source_kind"] = result.get("source_kind") or paper.get("source_kind") or "academic"
        result["authors"] = paper.get("authors") or []
        result["year"] = result.get("year") or paper.get("year") or ""
        result["doi"] = result.get("doi") or paper.get("doi") or ""

        if build_text:
            built = _full_text_chunks(result, existing) if result.get("downloaded") else {}

            if not built and (existing or {}).get("has_full_text"):
                # Marked full text but its chunks are gone: say so, so the
                # PDF is looked for again.
                get_store().upsert({"paper_id": result["paper_id"], "has_full_text": False, "chunk_version": None})

            if not built:
                # Không tải được PDF -> fallback dùng abstract để vẫn so khớp được.
                # Only saved to the store when it is new or the abstract changed.
                abstract = paper.get("abstract", "") or (existing or {}).get("abstract", "")
                built = build_fallback_chunks_from_abstract(
                    paper_id=result["paper_id"],
                    title=result.get("title", ""),
                    abstract=abstract,
                    save=existing is None or (existing.get("abstract") or "") != abstract
                    or bool(existing.get("has_full_text")),
                )

            result.update(built)

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

    os.makedirs(SECTIONS_DIR, exist_ok=True)
    sections_path = os.path.join(SECTIONS_DIR, paper_id + ".json")

    with open(sections_path, "w", encoding="utf-8") as f:
        json.dump(sections, f, ensure_ascii=False, indent=2)

    chunks = []

    for section_name, section_text in sections.items():
        if section_name == "title":
            continue

        if not section_text or len(section_text.strip()) < 50:
            continue

        text = section_text.strip()

        for start, end in sentence_windows(text, chunk_size, overlap):
            chunk_text = text[start:end].strip()

            if len(chunk_text) >= 80:
                chunks.append({
                    "paper_id": paper_id,
                    "section": section_name,
                    "chunk_id": f"{paper_id}_{section_name}_{len(chunks)}",
                    "start_char": start,
                    "end_char": end,
                    "text": chunk_text
                })

    chunks_path = _write_local_chunks(paper_id, chunks)

    if chunks:
        store = get_store()
        store.save_chunks(paper_id, chunks, "full_text")
        update = {"paper_id": paper_id, "has_full_text": True, "chunk_version": CHUNK_VERSION}
        # The abstract is what the cache is searched by; a paper found
        # without one gets it from its own text.
        abstract = (sections.get("abstract") or "").strip()
        existing = store.get_many([paper_id]).get(paper_id) or {}
        if abstract and not existing.get("abstract"):
            update["abstract"] = abstract[:4000]
        store.upsert(update)

    return {
        "paper_id": paper_id,
        "sections_built": True,
        "chunks_built": True,
        "sections_path": sections_path,
        "chunks_path": chunks_path,
        "num_chunks": len(chunks),
        "chunks_source": "full_text"
    }
