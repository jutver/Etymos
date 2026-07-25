import numpy as np
from embedding_model import embed_query, embed_passage


def cosine(a, b):
    return float(np.dot(a, b))


def rank_papers(weighted_sections, candidate_papers):
    results = []

    section_vectors = {}

    for section_name, item in weighted_sections.items():
        text = item["text"]
        weight = item["weight"]

        if len(text.strip()) < 50:
            continue

        section_vectors[section_name] = {
            "vector": embed_query(text),
            "weight": weight
        }

    for paper in candidate_papers:
        title = paper.get("title") or ""
        abstract = paper.get("abstract") or ""
        source_kind = paper.get("source_kind") or "academic"

        paper_text = title + "\n" + abstract

        # A <50-char title+abstract genuinely means "nothing to compare" for
        # an academic-paper candidate. It disproportionately kills thin
        # DuckDuckGo web results, though: a web page's value isn't measured
        # by title+abstract length the way a paper's is, so only require
        # *some* text (not 50 chars) for web-sourced candidates.
        min_len = 1 if source_kind == "web" else 50

        if len(paper_text.strip()) < min_len:
            continue

        paper_vector = embed_passage(paper_text)

        weighted_sum = 0.0
        total_weight = 0.0
        section_scores = {}

        for section_name, item in section_vectors.items():
            score = cosine(item["vector"], paper_vector)
            weight = item["weight"]

            section_scores[section_name] = score

            weighted_sum += score * weight
            total_weight += weight

        if total_weight == 0:
            continue

        final_score = weighted_sum / total_weight

        results.append({
            "title": title,
            "year": paper.get("year") or "",
            "doi": paper.get("doi") or "",
            "source": paper.get("source") or "",
            "source_kind": source_kind,
            "authors": paper.get("authors") or [],
            "url": paper.get("url") or "",
            "similarity": final_score,
            "section_scores": section_scores,
            "abstract": abstract[:500]
        })

    return sorted(
        results,
        key=lambda x: x["similarity"],
        reverse=True
    )