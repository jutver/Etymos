import os
import json
import numpy as np
from embedding_model import embed_query, embed_passage
import re

CACHE_DIR = "paper_cache"
CHUNKS_DIR = os.path.join(CACHE_DIR, "chunks")


SECTION_MATCH = {
    "abstract": ["abstract", "introduction"],
    "introduction": ["abstract", "introduction", "related_work"],
    "related_work": ["related_work", "introduction"],
    "method": ["method", "experiment"],
    "experiment": ["experiment", "method"],
    "conclusion": ["conclusion", "introduction"]
}


def cosine_similarity(a, b):
    a = np.array(a)
    b = np.array(b)

    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-8))


def load_chunks_from_file(path):
    if not path or not os.path.exists(path):
        return []

    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_candidate_chunks(cached_papers):
    all_chunks = []

    for paper in cached_papers:
        paper_id = paper.get("paper_id")
        chunks_path = paper.get("chunks_path")

        if not chunks_path:
            chunks_path = os.path.join(CHUNKS_DIR, paper_id + ".json")

        chunks = load_chunks_from_file(chunks_path)

        for chunk in chunks:
            chunk["source_paper_id"] = paper_id
            chunk["source_title"] = paper.get("title", "")
            chunk["source_url"] = paper.get("url", "")
            chunk["source_pdf_url"] = paper.get("pdf_url", "")
            # "web" vs "academic" (see search_paper/search_sources.py) plus
            # enough real metadata (authors/year/doi) to eventually feed
            # citations.py's format_reference() — see final_report_builder.py.
            chunk["source_kind"] = paper.get("source_kind") or "academic"
            chunk["source_authors"] = paper.get("authors") or []
            chunk["source_year"] = paper.get("year") or ""
            chunk["source_doi"] = paper.get("doi") or ""

        all_chunks.extend(chunks)

    return all_chunks


def filter_chunks_by_section(input_section, candidate_chunks):
    allowed_sections = SECTION_MATCH.get(input_section, [input_section])

    filtered = []

    for chunk in candidate_chunks:
        section = chunk.get("section")

        if section in allowed_sections:
            filtered.append(chunk)
            continue

        # Non-PDF / non-downloadable candidates (most web results, plus any
        # academic hit whose PDF failed to fetch) fall back to a single
        # "abstract" chunk built from title+snippet
        # (paper_cache.build_fallback_chunks_from_abstract) — they have no
        # real method/experiment/conclusion structure for SECTION_MATCH to
        # gate on, so the strict table above would otherwise exclude them
        # from ever matching those input sections even though their text is
        # exactly what a web source has to offer. Only relax this for
        # web-sourced candidates; a genuine academic paper (source_kind ==
        # "academic") that merely failed to download keeps the strict gating,
        # since an abstract really isn't a stand-in for its method section.
        if section == "abstract" and chunk.get("source_kind") == "web":
            filtered.append(chunk)

    return filtered


def embed_input_chunk(chunk):
    return embed_query(chunk.get("text", ""))


def embed_source_chunk(chunk):
    return embed_passage(chunk.get("text", ""))


def match_chunks(
    input_chunks,
    candidate_chunks,
    top_k=3,
    similarity_threshold=0.82
):
    matches = []

    print("\nEmbedding candidate chunks...")
    for chunk in candidate_chunks:
        chunk["embedding"] = embed_source_chunk(chunk)

    print("\nMatching input chunks...")

    for input_chunk in input_chunks:
        input_text = input_chunk.get("text", "")

        if len(input_text.strip()) < 80:
            continue

        input_section = input_chunk.get("section", "")
        filtered_candidates = filter_chunks_by_section(
            input_section,
            candidate_chunks
        )

        if not filtered_candidates:
            filtered_candidates = candidate_chunks

        input_embedding = embed_input_chunk(input_chunk)
        scored = []

        for source_chunk in filtered_candidates:
            sim = cosine_similarity(
                input_embedding,
                source_chunk["embedding"]
            )

            if sim < similarity_threshold:
                continue

            source_text = source_chunk.get("text", "")

            word_overlap = word_jaccard_similarity(input_text, source_text)
            char_overlap = char_ngram_jaccard(input_text, source_text)

            label = classify_match(
                semantic=sim,
                word_overlap=word_overlap,
                char_overlap=char_overlap
            )

            if label in ["likely_plagiarism", "suspicious"]:
                scored.append({
                    "input_chunk_id": input_chunk.get("chunk_id"),
                    "input_section": input_section,
                    "input_text": input_text,

                    # Where this chunk lives in the canonical document
                    # (document_model.build_document). Sentence offsets
                    # computed inside `input_text` are made absolute by
                    # adding input_chunk_doc_start — see
                    # sentence_matcher.verify_match_sentences.
                    "input_chunk_doc_start": input_chunk.get("doc_start_char"),
                    "input_chunk_doc_end": input_chunk.get("doc_end_char"),

                    "source_paper_id": source_chunk.get("source_paper_id"),
                    "source_title": source_chunk.get("source_title", ""),
                    "source_chunk_id": source_chunk.get("chunk_id"),
                    "source_section": source_chunk.get("section"),
                    "source_text": source_text,
                    "source_url": source_chunk.get("source_url", ""),
                    "source_pdf_url": source_chunk.get("source_pdf_url", ""),
                    "source_kind": source_chunk.get("source_kind", "academic"),
                    "source_authors": source_chunk.get("source_authors", []),
                    "source_year": source_chunk.get("source_year", ""),
                    "source_doi": source_chunk.get("source_doi", ""),

                    "semantic_similarity": sim,
                    "word_overlap": word_overlap,
                    "char_ngram_overlap": char_overlap,
                    "label": label
                })

        scored = sorted(
            scored,
            key=lambda x: x["semantic_similarity"],
            reverse=True
        )

        matches.extend(scored[:top_k])

    matches = sorted(
        matches,
        key=lambda x: x["semantic_similarity"],
        reverse=True
    )

    return matches

def normalize_for_overlap(text):
    text = text.lower()
    text = re.sub(r"[^a-zA-Z0-9À-ỹ\s]", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def word_jaccard_similarity(a, b):
    a_words = set(normalize_for_overlap(a).split())
    b_words = set(normalize_for_overlap(b).split())

    if not a_words or not b_words:
        return 0.0

    return len(a_words & b_words) / len(a_words | b_words)


def char_ngram_jaccard(a, b, n=5):
    a = normalize_for_overlap(a).replace(" ", "")
    b = normalize_for_overlap(b).replace(" ", "")

    if len(a) < n or len(b) < n:
        return 0.0

    a_grams = {a[i:i+n] for i in range(len(a) - n + 1)}
    b_grams = {b[i:i+n] for i in range(len(b) - n + 1)}

    return len(a_grams & b_grams) / len(a_grams | b_grams)


def classify_match(semantic, word_overlap, char_overlap):
    if semantic >= 0.90 and (word_overlap >= 0.28 or char_overlap >= 0.22):
        return "likely_plagiarism"

    if semantic >= 0.86 and (word_overlap >= 0.18 or char_overlap >= 0.15):
        return "suspicious"

    if semantic >= 0.88:
        return "related_only"

    return "weak_match"

def save_matches(matches, output_path):
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(matches, f, ensure_ascii=False, indent=2)


def print_matches(matches, top_k=20):
    print("\n===== CHUNK PLAGIARISM MATCHES =====")

    for i, match in enumerate(matches[:top_k], 1):
        print(f"\n{i}. Label: {match['label']}")
        print(f"Semantic: {match['semantic_similarity']:.4f}")
        print(f"Word overlap: {match['word_overlap']:.4f}")
        print(f"Char ngram overlap: {match['char_ngram_overlap']:.4f}")
        print("Input section:", match["input_section"])
        print("Source paper:", match["source_paper_id"])
        print("Source section:", match["source_section"])

        print("\nINPUT:")
        print(match["input_text"][:500])

        print("\nSOURCE:")
        print(match["source_text"][:500])

        print("-" * 80)