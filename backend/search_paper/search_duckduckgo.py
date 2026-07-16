from ddgs import DDGS
import time

_last_request_time = 0.0

def search_duckduckgo(query: str, max_results: int = 10, delay_seconds: float = 4.0) -> list[dict]:
    global _last_request_time
    results = []

    elapsed = time.time() - _last_request_time
    if elapsed < delay_seconds:
        time.sleep(delay_seconds - elapsed)

    _last_request_time = time.time()

    try:
        with DDGS() as ddgs:
            for r in ddgs.text(query, max_results=max_results):
                results.append({
                    "title": r.get("title", ""),
                    "year": "",
                    "doi": "",
                    "abstract": r.get("body", ""),
                    "url": r.get("href", ""),
                    "authors": [],
                    "source": "DuckDuckGo"
                })

    except Exception as e:
        print(f"DuckDuckGo error with query '{query}': {e}")

    return results