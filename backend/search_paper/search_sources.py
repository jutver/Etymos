from search_paper.search_arxiv import search_arxiv
from search_paper.search_duckduckgo import search_duckduckgo
from search_paper.search_semantic_scholar import search_semantic_scholar
from search_paper.search_openalex import search_openalex


def deduplicate_papers(papers):
    seen = set()
    unique = []

    for paper in papers:
        key = paper.get("doi") or paper.get("url") or paper.get("title")

        if not key:
            continue

        key = str(key).lower().strip()

        if key in seen:
            continue

        seen.add(key)
        unique.append(paper)

    return unique


# Which of the four sources are "web" (open, non-academic-structured
# results) vs "academic" (paper-search APIs). Used to tag every candidate
# with `source_kind` so downstream code (similarity.py's title/abstract
# length filter, plagiarism_matcher.py's SECTION_MATCH gating, and the
# report_store.py Supabase rows) can treat web-sourced candidates
# differently from genuine academic papers instead of the two being
# indistinguishable.
_WEB_SOURCES = {"DuckDuckGo"}


def search_all_sources(queries, max_results_per_source=10):
    all_papers = []

    for query in queries:
        print(f"\nQUERY: {query}")

        sources = [
            ("Semantic Scholar", search_semantic_scholar, query),
            ("OpenAlex", search_openalex, query),
            ("arXiv", search_arxiv, query),
            # Previously suffixed with "research paper", which systematically
            # biased DuckDuckGo (the one real open-web source in this list)
            # toward academic-sounding pages and away from the general web
            # results it's actually good at finding — the root cause behind
            # "only checks paper, not web". Search the query verbatim.
            ("DuckDuckGo", search_duckduckgo, query)
        ]

        for source_name, search_func, q in sources:
            try:
                results = search_func(
                    q,
                    max_results=max_results_per_source
                )

                source_kind = "web" if source_name in _WEB_SOURCES else "academic"
                for result in results:
                    result.setdefault("source_kind", source_kind)

                print(f"{source_name}: {len(results)}")
                all_papers.extend(results)

            except Exception as e:
                print(f"{source_name} error:", e)

    return deduplicate_papers(all_papers)