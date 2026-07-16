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

        paper_text = title + "\n" + abstract

        if len(paper_text.strip()) < 50:
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