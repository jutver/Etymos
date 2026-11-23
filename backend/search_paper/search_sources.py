import re

from search_paper.paper_identity import (
    canonical_paper_keys,
    classify_source_kind,
    normalized_title_key,
    strip_preprint_prefix,
)
from search_paper.search_arxiv import search_arxiv
from search_paper.search_duckduckgo import search_duckduckgo
from search_paper.search_semantic_scholar import search_semantic_scholar
from search_paper.search_openalex import search_openalex


_LINK_FIELDS = ("pdf_url", "arxiv_id", "acl_id", "doi", "abstract", "url")


def _title_key(title):
    return normalized_title_key(title)


def _keys(paper):
    return canonical_paper_keys(paper)


def _normalize_candidate(paper):
    """Classify academic repository URLs/IDs and strip noisy preprint prefixes."""
    kind = classify_source_kind(paper)
    paper["source_kind"] = kind
    if kind == "academic" and paper.get("title"):
        cleaned = strip_preprint_prefix(paper["title"])
        if cleaned:
            paper["title"] = cleaned
    return paper


def deduplicate_papers(papers):
    """One candidate per paper: results are the same paper when they share a
    DOI, arXiv ID, ACL ID, normalized title, or URL. Academic classification
    and clean bibliographic metadata take precedence over web hits."""
    seen = {}
    unique = []

    for paper in papers:
        _normalize_candidate(paper)
        keys = _keys(paper)

        if not keys:
            continue

        kept = next((seen[key] for key in keys if key in seen), None)

        if kept is not None:
            # Academic always takes precedence over web when unifying duplicates.
            if paper.get("source_kind") == "academic" and kept.get("source_kind") != "academic":
                kept["source_kind"] = "academic"
                if paper.get("title"):
                    kept["title"] = strip_preprint_prefix(paper["title"]) or paper["title"]
            elif kept.get("source_kind") == "academic" and kept.get("title"):
                kept["title"] = strip_preprint_prefix(kept["title"]) or kept["title"]

            # Merge missing links and bibliographic metadata from the duplicate.
            for field in _LINK_FIELDS:
                if paper.get(field) and not kept.get(field):
                    kept[field] = paper[field]
            if paper.get("authors") and not kept.get("authors"):
                kept["authors"] = paper["authors"]
            if paper.get("year") and not kept.get("year"):
                kept["year"] = paper["year"]

            for key in keys:
                seen.setdefault(key, kept)
            continue

        for key in keys:
            seen[key] = paper
        unique.append(paper)

    return unique


# Which sources are "web" vs "academic".
# DuckDuckGo = web search
# Semantic Scholar + OpenAlex (+ arXiv when both fail) = academic paper search
_WEB_SOURCES = {"DuckDuckGo"}


def _search_cache(queries):
    try:
        from paper_cache import search_cached_papers
        return search_cached_papers(queries)
    except Exception as e:
        print("Paper cache search error:", e)
        return []


def search_all_sources(queries, max_results_per_source=10):
    # Papers earlier checks already found come first: deduplication keeps
    # the first copy, so a known paper keeps its cached full text and the
    # search results only add links to it.
    all_papers = _search_cache(queries)
    print(f"Paper cache: {len(all_papers)}")

    for query in queries:
        print(f"\nQUERY: {query}")

        sources = [
            ("Semantic Scholar", search_semantic_scholar, query),
            ("OpenAlex", search_openalex, query),
            ("DuckDuckGo", search_duckduckgo, query),
        ]
        academic_found = 0

        for source_name, search_func, q in sources:
            try:
                results = search_func(
                    q,
                    max_results=max_results_per_source
                )

                source_kind = (
                    "web"
                    if source_name in _WEB_SOURCES
                    else "academic"
                )

                for result in results:
                    result.setdefault("source_kind", source_kind)

                if source_kind == "academic":
                    academic_found += len(results)

                print(f"{source_name}: {len(results)}")
                all_papers.extend(results)

            except Exception as e:
                print(f"{source_name} error:", e)

        # Both academic APIs empty usually means rate limited, not that no
        # paper exists: ask arXiv, which has no daily budget.
        if not academic_found:
            try:
                results = search_arxiv(query, max_results=max_results_per_source, max_retries=1)
                for result in results:
                    result.setdefault("source_kind", "academic")
                print(f"arXiv: {len(results)}")
                all_papers.extend(results)
            except Exception as e:
                print("arXiv error:", e)

    return deduplicate_papers(all_papers)
