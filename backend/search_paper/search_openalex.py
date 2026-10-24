import re
import requests
import time

_last_openalex_time = 0.0

def reconstruct_openalex_abstract(inverted_index):
    if not inverted_index:
        return ""

    words = []

    for word, positions in inverted_index.items():
        for pos in positions:
            words.append((pos, word))

    words = sorted(words)
    return " ".join([word for pos, word in words])


def openalex_doi(item):
    """OpenAlex gives DOIs as "https://doi.org/10.x/y"; the other sources
    give the bare "10.x/y". Bare everywhere, so one paper found by two
    sources is recognised as the same paper."""
    doi = item.get("doi") or ""
    return re.sub(r"^https?://(dx\.)?doi\.org/", "", doi, flags=re.I)


def openalex_pdf_url(item):
    """The open-access PDF, so the paper's full text is compared and not
    only its abstract."""
    best = item.get("best_oa_location") or {}
    if best.get("pdf_url"):
        return best["pdf_url"]
    for location in item.get("locations") or []:
        if (location or {}).get("pdf_url"):
            return location["pdf_url"]
    # May be a landing page; download_pdf follows its citation_pdf_url.
    return (item.get("open_access") or {}).get("oa_url") or ""


def openalex_arxiv_id(item):
    for location in item.get("locations") or []:
        for url in ((location or {}).get("landing_page_url"), (location or {}).get("pdf_url")):
            match = re.search(r"arxiv\.org/(?:abs|pdf)/(\d{4}\.\d{4,5})", url or "")
            if match:
                return match.group(1)
    return ""


def search_openalex(query: str, max_results: int = 10, delay_seconds: float = 1.0) -> list[dict]:
    global _last_openalex_time
    results = []

    elapsed = time.time() - _last_openalex_time
    if elapsed < delay_seconds:
        time.sleep(delay_seconds - elapsed)

    _last_openalex_time = time.time()

    url = "https://api.openalex.org/works"

    params = {
        "search": query,
        "per-page": max_results
    }

    try:
        response = requests.get(url, params=params, timeout=15)
        response.raise_for_status()

        data = response.json()

        for item in data.get("results", []):
            abstract = reconstruct_openalex_abstract(
                item.get("abstract_inverted_index")
            )

            results.append({
                "title": item.get("title") or "",
                "year": item.get("publication_year") or "",
                "doi": openalex_doi(item),
                "abstract": abstract,
                "url": item.get("id") or "",
                "pdf_url": openalex_pdf_url(item),
                "arxiv_id": openalex_arxiv_id(item),
                "authors": [],
                "source": "OpenAlex"
            })

    except Exception as e:
        print(f"OpenAlex error with query '{query}': {e}")

    return results