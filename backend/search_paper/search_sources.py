
from search_paper.search_duckduckgo import search_duckduckgo
from search_paper.search_semantic_scholar import search_semantic_scholar
from search_paper.search_openalex import search_openalex


_LINK_FIELDS = ("pdf_url", "arxiv_id", "acl_id")


def deduplicate_papers(papers):
    seen = {}
    unique = []

    for paper in papers:
        key = paper.get("doi") or paper.get("url") or paper.get("title")

        if not key:
            continue

        key = str(key).lower().strip()

        if key in seen:
            # Keep the first copy, but take the links another source
            # found for it (OpenAlex often has the PDF Semantic Scholar lacks).
            kept = seen[key]
            for field in _LINK_FIELDS:
                if paper.get(field) and not kept.get(field):
                    kept[field] = paper[field]
            continue

        seen[key] = paper
        unique.append(paper)

    return unique


# Which sources are "web" vs "academic".
# DuckDuckGo = web search
# Semantic Scholar + OpenAlex = academic paper search
_WEB_SOURCES = {"DuckDuckGo"}


def search_all_sources(queries, max_results_per_source=10):
    all_papers = []

    for query in queries:
        print(f"\nQUERY: {query}")

        sources = [
            ("Semantic Scholar", search_semantic_scholar, query),
            ("OpenAlex", search_openalex, query),
            ("DuckDuckGo", search_duckduckgo, query),
        ]

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

                print(f"{source_name}: {len(results)}")
                all_papers.extend(results)

            except Exception as e:
                print(f"{source_name} error:", e)

    return deduplicate_papers(all_papers)


