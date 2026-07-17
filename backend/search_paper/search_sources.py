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


def search_all_sources(queries, max_results_per_source=10):
    all_papers = []

    for query in queries:
        print(f"\nQUERY: {query}")

        sources = [
            ("Semantic Scholar", search_semantic_scholar, query),
            ("OpenAlex", search_openalex, query),
            ("arXiv", search_arxiv, query),
            ("DuckDuckGo", search_duckduckgo, f"{query} research paper")
        ]

        for source_name, search_func, q in sources:
            try:
                results = search_func(
                    q,
                    max_results=max_results_per_source
                )

                print(f"{source_name}: {len(results)}")
                all_papers.extend(results)

            except Exception as e:
                print(f"{source_name} error:", e)

    return deduplicate_papers(all_papers)