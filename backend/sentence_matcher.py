import re
import json
import numpy as np
from embedding_model import embed_query, embed_passage
from plagiarism_matcher import (
    cosine_similarity,
    word_jaccard_similarity,
    char_ngram_jaccard
)

def is_common_academic_definition(text):
    text = text.lower()

    common_terms = [
        "accuracy",
        "precision",
        "recall",
        "f1-score",
        "f1 score",
        "confusion matrix",
        "true positives",
        "true negatives",
        "false positives",
        "false negatives",
        "tp",
        "tn",
        "fp",
        "fn",
        "harmonic mean",
        "evaluation metric",
        "performance metric"
    ]

    count = sum(1 for term in common_terms if term in text)

    return count >= 2

def split_sentences(text):
    text = re.sub(r"\s+", " ", text.strip())

    sentences = re.split(
        r"(?<=[.!?])\s+|(?<=\))\s+(?=[A-Z])",
        text
    )

    clean = []

    for s in sentences:
        s = s.strip()

        if len(s) >= 40:
            clean.append(s)

    return clean


def classify_sentence_match(semantic, word_overlap, char_overlap, input_sentence="", source_sentence=""):
    combined = input_sentence + " " + source_sentence

    # exact / near-exact copy
    if word_overlap >= 0.85 or char_overlap >= 0.85:
        return "likely_plagiarism"

    if is_common_academic_definition(combined):
        if semantic >= 0.88 and (word_overlap >= 0.18 or char_overlap >= 0.15):
            return "common_academic_definition"

    if semantic >= 0.92 and (word_overlap >= 0.35 or char_overlap >= 0.30):
        return "likely_plagiarism"

    if semantic >= 0.88 and (word_overlap >= 0.22 or char_overlap >= 0.18):
        return "suspicious"

    return "related_only"


def verify_match_sentences(match, top_k=3):
    input_sentences = split_sentences(match["input_text"])
    source_sentences = split_sentences(match["source_text"])

    if not input_sentences or not source_sentences:
        return []

    source_embeddings = [
        embed_passage(s)
        for s in source_sentences
    ]

    sentence_matches = []

    for i, input_sentence in enumerate(input_sentences):
        input_embedding = embed_query(input_sentence)

        scored = []

        for j, source_sentence in enumerate(source_sentences):
            semantic = cosine_similarity(
                input_embedding,
                source_embeddings[j]
            )

            word_overlap = word_jaccard_similarity(
                input_sentence,
                source_sentence
            )

            char_overlap = char_ngram_jaccard(
                input_sentence,
                source_sentence
            )

            label = classify_sentence_match(
                semantic=semantic,
                word_overlap=word_overlap,
                char_overlap=char_overlap,
                input_sentence=input_sentence,
                source_sentence=source_sentence
            )

            if label in ["likely_plagiarism", "suspicious", "common_academic_definition"]:
                scored.append({
                    "input_sentence_index": i,
                    "source_sentence_index": j,
                    "input_sentence": input_sentence,
                    "source_sentence": source_sentence,
                    "semantic_similarity": semantic,
                    "word_overlap": word_overlap,
                    "char_ngram_overlap": char_overlap,
                    "label": label
                })

        scored = sorted(
            scored,
            key=lambda x: x["semantic_similarity"],
            reverse=True
        )

        sentence_matches.extend(scored[:top_k])

    return sentence_matches


def verify_all_matches(matches):
    verified = []

    for match in matches:
        sentence_matches = verify_match_sentences(match)

        if not sentence_matches:
            continue

        verified.append({
            "input_chunk_id": match["input_chunk_id"],
            "input_section": match["input_section"],
            "source_paper_id": match["source_paper_id"],
            "source_title": match.get("source_title", ""),
            "source_chunk_id": match["source_chunk_id"],
            "source_section": match["source_section"],
            "chunk_semantic_similarity": match["semantic_similarity"],
            "chunk_word_overlap": match["word_overlap"],
            "chunk_char_ngram_overlap": match["char_ngram_overlap"],
            "chunk_label": match["label"],
            "sentence_matches": sentence_matches
        })

    return verified


def save_verified_matches(verified_matches, output_path):
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(verified_matches, f, ensure_ascii=False, indent=2)


def print_verified_matches(verified_matches, top_k=10):
    print("\n===== SENTENCE LEVEL MATCHES =====")

    for i, item in enumerate(verified_matches[:top_k], 1):
        print(f"\n{i}. Source paper: {item['source_paper_id']}")
        print("Input section:", item["input_section"])
        print("Source section:", item["source_section"])
        print(f"Chunk similarity: {item['chunk_semantic_similarity']:.4f}")

        for sm in item["sentence_matches"][:3]:
            print(f"\nLabel: {sm['label']}")
            print(f"Semantic: {sm['semantic_similarity']:.4f}")
            print(f"Word overlap: {sm['word_overlap']:.4f}")
            print(f"Char overlap: {sm['char_ngram_overlap']:.4f}")

            print("\nINPUT SENTENCE:")
            print(sm["input_sentence"])

            print("\nSOURCE SENTENCE:")
            print(sm["source_sentence"])

        print("-" * 80)