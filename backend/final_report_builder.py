import json
from collections import defaultdict


LABEL_WEIGHT = {
    "likely_plagiarism": 1.0,
    "suspicious": 0.5,
    "common_academic_definition": 0.1
}


def build_final_report(verified_matches, input_chunks, input_text=None):
    total_chars = sum(len(c.get("text", "")) for c in input_chunks)
    matched_chars = 0

    if input_text is None:
        input_text = " ".join(
            chunk.get("text", "") for chunk in input_chunks if isinstance(chunk, dict)
        ).strip()

    paper_groups = defaultdict(lambda: {
        "source_paper_id": "",
        "source_title": "",
        "matches": [],
        "likely_count": 0,
        "suspicious_count": 0,
        "common_definition_count": 0,
        "max_similarity": 0.0
    })

    final_matches = []

    seen = set()

    for item in verified_matches:
        source_id = item["source_paper_id"]

        for sm in item["sentence_matches"]:
            key = (
                item["input_chunk_id"],
                source_id,
                sm["input_sentence_index"],
                sm["source_sentence_index"]
            )

            if key in seen:
                continue

            seen.add(key)

            label = sm["label"]
            weight = LABEL_WEIGHT.get(label, 0)

            char_len = len(sm["input_sentence"])
            matched_chars += char_len * weight

            record = {
                "label": label,
                "input_section": item["input_section"],
                "source_paper_id": source_id,
                "source_title": item.get("source_title", ""),
                "source_section": item["source_section"],
                "input_chunk_id": item["input_chunk_id"],
                "source_chunk_id": item["source_chunk_id"],
                "input_sentence": sm["input_sentence"],
                "source_sentence": sm["source_sentence"],
                "semantic_similarity": sm["semantic_similarity"],
                "word_overlap": sm["word_overlap"],
                "char_ngram_overlap": sm["char_ngram_overlap"]
            }

            final_matches.append(record)

            group = paper_groups[source_id]
            group["source_paper_id"] = source_id
            group["source_title"] = item.get("source_title", "")
            group["matches"].append(record)
            group["max_similarity"] = max(
                group["max_similarity"],
                sm["semantic_similarity"]
            )

            if label == "likely_plagiarism":
                group["likely_count"] += 1
            elif label == "suspicious":
                group["suspicious_count"] += 1
            elif label == "common_academic_definition":
                group["common_definition_count"] += 1

    overall_score = 0.0
    if total_chars > 0:
        overall_score = min(100.0, matched_chars / total_chars * 100)

    matched_papers = sorted(
        paper_groups.values(),
        key=lambda x: (
            x["likely_count"],
            x["suspicious_count"],
            x["max_similarity"]
        ),
        reverse=True
    )

    final_matches = sorted(
        final_matches,
        key=lambda x: (
            x["label"] == "likely_plagiarism",
            x["semantic_similarity"]
        ),
        reverse=True
    )

    return {
        "overall_score": round(overall_score, 2),
        "total_input_chunks": len(input_chunks),
        "matched_papers": matched_papers,
        "matches": final_matches,
        "input_text": input_text or "",
    }


def save_final_report(report, output_path):
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)


def print_final_report(report, top_k=10):
    print("\n===== FINAL PLAGIARISM REPORT =====")
    print("Overall score:", report["overall_score"], "%")
    print("Total input chunks:", report["total_input_chunks"])

    print("\n===== MATCHED PAPERS =====")
    for paper in report["matched_papers"]:
        print(
            paper["source_paper_id"],
            "| likely:",
            paper["likely_count"],
            "| suspicious:",
            paper["suspicious_count"],
            "| common:",
            paper["common_definition_count"],
            "| max:",
            round(paper["max_similarity"], 4)
        )

    print("\n===== TOP MATCHES =====")
    for i, m in enumerate(report["matches"][:top_k], 1):
        print(f"\n{i}. {m['label']} | {m['semantic_similarity']:.4f}")
        print("Section:", m["input_section"])
        print("Source:", m["source_paper_id"])
        print("INPUT:", m["input_sentence"][:300])
        print("SOURCE:", m["source_sentence"][:300])