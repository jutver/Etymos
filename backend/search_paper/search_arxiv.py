
import requests
import xml.etree.ElementTree as ET
import urllib.parse
import time
import random

_last_request_time = 0.0

# Session dùng lại connection thay vì tạo connection mới mỗi request
_session = requests.Session()

_session.headers.update({
    "User-Agent": "Etymos/1.0 (academic research; contact: your-email@example.com)"
})


def search_arxiv(
    query: str,
    max_results: int = 10,
    delay_seconds: float = 3.0,
    max_retries: int = 4,
) -> list[dict]:

    global _last_request_time

    results = []

    # ---------------------------------------------------------
    # 1. Rate limit request
    # ---------------------------------------------------------
    elapsed = time.time() - _last_request_time

    if elapsed < delay_seconds:
        time.sleep(delay_seconds - elapsed)

    # ---------------------------------------------------------
    # 2. Encode query
    # ---------------------------------------------------------
    encoded_query = urllib.parse.quote(query)

    url = (
        "https://export.arxiv.org/api/query"
        f"?search_query=all:{encoded_query}"
        f"&max_results={max_results}"
    )

    # ---------------------------------------------------------
    # 3. Retry loop
    # ---------------------------------------------------------
    for attempt in range(max_retries + 1):

        try:
            _last_request_time = time.time()

            response = _session.get(
                url,
                timeout=(10, 60),  # connect timeout, read timeout
            )

            # -------------------------------------------------
            # 429: Rate limited
            # -------------------------------------------------
            if response.status_code == 429:

                retry_after = response.headers.get("Retry-After")

                if retry_after:
                    try:
                        wait_time = float(retry_after)
                    except ValueError:
                        wait_time = 10.0
                else:
                    # Exponential backoff:
                    # 10s -> 20s -> 40s -> 80s
                    wait_time = 10 * (2 ** attempt)

                # Random jitter tránh nhiều process retry cùng lúc
                wait_time += random.uniform(0, 3)

                if attempt >= max_retries:
                    print(
                        f"arXiv rate limit exceeded for query "
                        f"'{query}'. Giving up after {attempt + 1} attempts."
                    )
                    return []

                print(
                    f"arXiv rate limited (429) for query "
                    f"'{query}'. "
                    f"Retrying in {wait_time:.1f}s "
                    f"(attempt {attempt + 1}/{max_retries})..."
                )

                time.sleep(wait_time)
                continue

            # -------------------------------------------------
            # 5xx: Server error
            # -------------------------------------------------
            if 500 <= response.status_code < 600:

                if attempt >= max_retries:
                    print(
                        f"arXiv server error {response.status_code} "
                        f"for query '{query}'. Giving up."
                    )
                    return []

                wait_time = 5 * (2 ** attempt) + random.uniform(0, 2)

                print(
                    f"arXiv server error {response.status_code} "
                    f"for query '{query}'. "
                    f"Retrying in {wait_time:.1f}s..."
                )

                time.sleep(wait_time)
                continue

            # -------------------------------------------------
            # Other HTTP errors
            # -------------------------------------------------
            response.raise_for_status()

            # -------------------------------------------------
            # 4. Parse XML
            # -------------------------------------------------
            root = ET.fromstring(response.text)

            ns = {
                "atom": "http://www.w3.org/2005/Atom"
            }

            for entry in root.findall("atom:entry", ns):

                title = entry.find("atom:title", ns)
                summary = entry.find("atom:summary", ns)
                url_id = entry.find("atom:id", ns)
                published = entry.find("atom:published", ns)

                authors = [
                    a.find("atom:name", ns).text.strip()
                    for a in entry.findall("atom:author", ns)
                    if a.find("atom:name", ns) is not None
                    and a.find("atom:name", ns).text
                ]

                year = ""

                if published is not None and published.text:
                    year = published.text[:4]

                results.append({
                    "title": (
                        title.text.strip().replace("\n", " ")
                        if title is not None and title.text
                        else ""
                    ),
                    "year": year,
                    "doi": "",
                    "abstract": (
                        summary.text.strip().replace("\n", " ")
                        if summary is not None and summary.text
                        else ""
                    ),
                    "url": (
                        url_id.text.strip()
                        if url_id is not None and url_id.text
                        else ""
                    ),
                    "authors": authors,
                    "source": "arXiv",
                })

            return results

        # -----------------------------------------------------
        # Timeout
        # -----------------------------------------------------
        except requests.exceptions.Timeout:

            if attempt >= max_retries:
                print(
                    f"arXiv timeout for query '{query}'. "
                    f"Giving up after {attempt + 1} attempts."
                )
                return []

            wait_time = 5 * (2 ** attempt) + random.uniform(0, 2)

            print(
                f"arXiv timeout for query '{query}'. "
                f"Retrying in {wait_time:.1f}s..."
            )

            time.sleep(wait_time)

        # -----------------------------------------------------
        # Connection error
        # -----------------------------------------------------
        except requests.exceptions.ConnectionError as e:

            if attempt >= max_retries:
                print(
                    f"arXiv connection error for query "
                    f"'{query}': {e}"
                )
                return []

            wait_time = 5 * (2 ** attempt) + random.uniform(0, 2)

            print(
                f"arXiv connection error for query '{query}'. "
                f"Retrying in {wait_time:.1f}s..."
            )

            time.sleep(wait_time)

        # -----------------------------------------------------
        # XML parsing error
        # -----------------------------------------------------
        except ET.ParseError as e:

            print(
                f"arXiv returned invalid XML for query "
                f"'{query}': {e}"
            )
            return []

        # -----------------------------------------------------
        # Unexpected error
        # -----------------------------------------------------
        except Exception as e:

            print(
                f"arXiv error with query '{query}': {e}"
            )
            return []

    return results

