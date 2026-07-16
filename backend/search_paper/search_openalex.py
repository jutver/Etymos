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
                "doi": item.get("doi") or "",
                "abstract": abstract,
                "url": item.get("id") or "",
                "authors": [],
                "source": "OpenAlex"
            })

    except Exception as e:
        print(f"OpenAlex error with query '{query}': {e}")

    return results