import requests
import time

_last_semantic_time = 0.0

def search_semantic_scholar(query: str, max_results: int = 10, delay_seconds: float = 5.0) -> list[dict]:
    global _last_semantic_time
    results = []

    elapsed = time.time() - _last_semantic_time
    if elapsed < delay_seconds:
        time.sleep(delay_seconds - elapsed)

    _last_semantic_time = time.time()

    url = "https://api.semanticscholar.org/graph/v1/paper/search"

    params = {
        "query": query,
        "limit": max_results,
        "fields": "title,year,abstract,authors,externalIds,url"
    }

    try:
        response = requests.get(url, params=params, timeout=15)

        if response.status_code == 429:
            print("Semantic Scholar rate limited. Skipping this query.")
            return results

        response.raise_for_status()
        data = response.json()

        for item in data.get("data", []):
            external_ids = item.get("externalIds") or {}
            authors = [
                a.get("name")
                for a in item.get("authors", [])
                if a.get("name")
            ]

            results.append({
                "title": item.get("title", ""),
                "year": item.get("year", ""),
                "doi": external_ids.get("DOI", ""),
                "abstract": item.get("abstract") or "",
                "url": item.get("url", ""),
                "authors": authors,
                "source": "Semantic Scholar"
            })

    except Exception as e:
        print(f"Semantic Scholar error with query '{query}': {e}")

    return results