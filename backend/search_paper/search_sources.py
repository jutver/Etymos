import re

from search_paper.search_arxiv import search_arxiv
from search_paper.search_duckduckgo import search_duckduckgo
from search_paper.search_semantic_scholar import search_semantic_scholar
from search_paper.search_openalex import search_openalex


_LINK_FIELDS = ("pdf_url", "arxiv_id", "acl_id", "doi", "abstract")

# Shorter titles ("Introduction", "Home") are too generic to say two results
# are the same paper.
_MIN_TITLE_KEY = 20


def _title_key(title):
    title = re.sub(r"[^a-z0-9\s]", " ", (title or "").lower())
    return re.sub(r"\s+", " ", title).strip()


def _keys(paper):
    keys = [str(paper[field]).lower().strip() for field in ("doi", "url") if paper.get(field)]
    title = _title_key(paper.get("title"))
    if len(title) >= _MIN_TITLE_KEY:
        keys.append("title:" + title)
    return keys


def deduplicate_papers(papers):
    """One candidate per paper: results are the same paper when they share a
    DOI, a URL or a (long enough) title."""
    seen = {}
    unique = []

    for paper in papers:
        keys = _keys(paper)

        if not keys:
            continue

        kept = next((seen[key] for key in keys if key in seen), None)

        if kept is not None:
            # Keep the first copy, but take the links another source
            # found for it (OpenAlex often has the PDF Semantic Scholar lacks).
            for field in _LINK_FIELDS:
                if paper.get(field) and not kept.get(field):
                    kept[field] = paper[field]
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
