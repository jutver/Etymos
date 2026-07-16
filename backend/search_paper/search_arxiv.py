import requests
import xml.etree.ElementTree as ET
import urllib.parse
import time

_last_request_time = 0.0

def search_arxiv(query: str, max_results: int = 10, delay_seconds: float = 3.0) -> list[dict]:
    global _last_request_time
    results = []

    elapsed = time.time() - _last_request_time
    if elapsed < delay_seconds:
        time.sleep(delay_seconds - elapsed)

    _last_request_time = time.time()

    encoded_query = urllib.parse.quote(query)
    url = f"http://export.arxiv.org/api/query?search_query=all:{encoded_query}&max_results={max_results}"

    try:
        response = requests.get(url, timeout=15)
        response.raise_for_status()

        root = ET.fromstring(response.text)
        ns = {"atom": "http://www.w3.org/2005/Atom"}

        for entry in root.findall("atom:entry", ns):
            title = entry.find("atom:title", ns)
            summary = entry.find("atom:summary", ns)
            url_id = entry.find("atom:id", ns)
            published = entry.find("atom:published", ns)

            authors = [
                a.find("atom:name", ns).text.strip()
                for a in entry.findall("atom:author", ns)
                if a.find("atom:name", ns) is not None
            ]

            year = ""
            if published is not None and published.text:
                year = published.text[:4]

            results.append({
                "title": title.text.strip().replace("\n", " ") if title is not None else "",
                "year": year,
                "doi": "",
                "abstract": summary.text.strip().replace("\n", " ") if summary is not None else "",
                "url": url_id.text.strip() if url_id is not None else "",
                "authors": authors,
                "source": "arXiv"
            })

    except Exception as e:
        print(f"arXiv error with query '{query}': {e}")

    return results