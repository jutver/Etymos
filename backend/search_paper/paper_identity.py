"""Canonical paper identity, preprint title normalization, and academic URL classification."""

from __future__ import annotations

import re
from urllib.parse import urlparse

_ARXIV_ID_RE = re.compile(r"(?:^|/|arxiv:|\[)(\d{4}\.\d{4,5})(?:v\d+)?(?:\b|\]|\.pdf|$)", re.IGNORECASE)
_DOI_RE = re.compile(r"(10\.\d{4,9}/[^\s?#]+)", re.IGNORECASE)
_PREPRINT_PREFIX_RE = re.compile(
    r"^\s*(?:\[(?:arXiv:)?\d{4}\.\d{4,5}(?:v\d+)?\]|arXiv:\d{4}\.\d{4,5}(?:v\d+)?\s*[-:]?|\[[a-z\-]+(?:\.[A-Z]{2})?\])\s*",
    re.IGNORECASE,
)

_MIN_TITLE_KEY = 20

_ACADEMIC_HOSTS = (
    "arxiv.org",
    "ar5iv.labs.arxiv.org",
    "aclanthology.org",
    "openreview.net",
    "proceedings.mlr.press",
    "papers.nips.cc",
    "proceedings.neurips.cc",
    "ieeexplore.ieee.org",
    "dl.acm.org",
    "link.springer.com",
    "sciencedirect.com",
    "pubmed.ncbi.nlm.nih.gov",
    "pmc.ncbi.nlm.nih.gov",
    "semanticscholar.org",
    "openalex.org",
    "doi.org",
    "dx.doi.org",
    "onlinelibrary.wiley.com",
    "tandfonline.com",
    "mdpi.com",
    "frontiersin.org",
    "journals.plos.org",
    "biorxiv.org",
    "medrxiv.org",
    "hal.science",
    "ceur-ws.org",
    "ojs.aaai.org",
    "ijcai.org",
    "core.ac.uk",
)

_ACADEMIC_HOST_PATH_PREFIXES = (
    ("nature.com", "/articles"),
    ("science.org", "/doi"),
    ("researchgate.net", "/publication"),
    ("ncbi.nlm.nih.gov", "/pmc"),
    ("ssrn.com", "/abstract"),
    ("papers.ssrn.com", "/"),
)


def strip_preprint_prefix(title: str | None) -> str:
    """Remove leading preprint/arXiv bracketed prefixes such as '[2405.14141] '."""
    cleaned = (title or "").strip()
    while cleaned:
        updated = _PREPRINT_PREFIX_RE.sub("", cleaned).strip()
        if updated == cleaned:
            break
        cleaned = updated
    return cleaned


def extract_arxiv_id(value: str | None) -> str:
    """Return normalized arXiv ID (without version suffix) if present."""
    if not value:
        return ""
    match = _ARXIV_ID_RE.search(str(value).strip())
    return match.group(1).lower() if match else ""


def extract_doi(value: str | None) -> str:
    """Return normalized lowercase DOI if present in a DOI string or URL."""
    if not value:
        return ""
    match = _DOI_RE.search(str(value).strip())
    if not match:
        return ""
    return match.group(1).rstrip(".,;)").lower()


def is_academic_url(url: str | None) -> bool:
    """Return True when the URL points to a recognized scholarly paper repository."""
    if not url:
        return False
    try:
        parsed = urlparse(str(url).strip())
    except ValueError:
        return False
    host = (parsed.netloc or "").lower().removeprefix("www.")
    if not host:
        return False
    if any(host == domain or host.endswith("." + domain) for domain in _ACADEMIC_HOSTS):
        return True
    path = (parsed.path or "").lower()
    return any(
        (host == domain or host.endswith("." + domain)) and path.startswith(prefix)
        for domain, prefix in _ACADEMIC_HOST_PATH_PREFIXES
    )


def normalized_title_key(title: str | None) -> str:
    """Lowercase alphanumeric title key with preprint prefixes removed."""
    cleaned = strip_preprint_prefix(title).lower()
    cleaned = re.sub(r"[^a-z0-9\s]", " ", cleaned)
    return re.sub(r"\s+", " ", cleaned).strip()


def classify_source_kind(record: dict) -> str:
    """Determine 'academic' vs 'web' for a candidate paper or match record."""
    if record.get("source_kind") == "academic":
        return "academic"
    url = record.get("url") or record.get("source_url") or ""
    pdf_url = record.get("pdf_url") or record.get("source_pdf_url") or ""
    doi = record.get("doi") or record.get("source_doi") or extract_doi(url)
    arxiv_id = (
        record.get("arxiv_id")
        or extract_arxiv_id(url)
        or extract_arxiv_id(pdf_url)
        or extract_arxiv_id(record.get("title") or record.get("source_title"))
    )
    if doi or arxiv_id or record.get("acl_id") or is_academic_url(url) or is_academic_url(pdf_url):
        return "academic"
    return "web"


def canonical_paper_keys(record: dict) -> list[str]:
    """Return all deduplication keys for a candidate paper or match record."""
    keys: list[str] = []
    url = record.get("url") or record.get("source_url") or ""
    pdf_url = record.get("pdf_url") or record.get("source_pdf_url") or ""
    doi = extract_doi(record.get("doi") or record.get("source_doi")) or extract_doi(url)
    if doi:
        keys.append(f"doi:{doi}")
    arxiv_id = (
        extract_arxiv_id(record.get("arxiv_id"))
        or extract_arxiv_id(url)
        or extract_arxiv_id(pdf_url)
        or extract_arxiv_id(record.get("title") or record.get("source_title"))
    )
    if arxiv_id:
        keys.append(f"arxiv:{arxiv_id}")
    if record.get("acl_id"):
        keys.append(f"acl:{str(record['acl_id']).lower().strip()}")
    title_key = normalized_title_key(record.get("title") or record.get("source_title"))
    if len(title_key) >= _MIN_TITLE_KEY:
        keys.append(f"title:{title_key}")
    if url:
        keys.append(f"url:{str(url).lower().strip().rstrip('/')}")
    return keys


def primary_canonical_key(record: dict) -> str:
    """Return the strongest single canonical key for grouping a paper."""
    keys = canonical_paper_keys(record)
    if keys:
        return keys[0]
    return str(record.get("source_paper_id") or record.get("paper_id") or "")
