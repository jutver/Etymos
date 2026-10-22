"""
Quick re-check of one edited passage ("check nhanh").

After a user accepts an AI rewrite, or edits a flagged passage by hand, the
Report page asks whether the new wording still overlaps a source. Running the
whole pipeline again (search -> download -> chunk -> match) for that would
take minutes and spend search/download quota, so this only compares the new
text with the sources the report ALREADY found:

  * the chunks of every source paper in the report, which paper_cache saved
    to disk during the original check (no network access here), and
  * every matched source sentence stored on the report itself, as a fallback
    for sources whose chunks are not on this machine (e.g. a report restored
    from Supabase after a redeploy).

So it catches "the rewrite still copies source A" and "the edit now copies
source B from the same report". It cannot catch a match with a source the
report never found; only a full re-check can (see the Report page's
"estimated" score note).

Labels and thresholds are exactly sentence_matcher.classify_sentence_match(),
so a quick-check verdict agrees with what the full check would decide for the
same pair of sentences. Every flag label needs word overlap >= 0.18 or char
overlap >= 0.15, so pairs below that are skipped before any embedding is
computed — that is exact, not an approximation, and keeps the check fast.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
from collections import OrderedDict
from typing import Any

import numpy as np

from document_model import LABEL_WEIGHT, split_sentences_with_spans
from plagiarism_matcher import (
    CHUNKS_DIR,
    load_chunks_from_file,
    normalize_for_overlap,
)
from sentence_matcher import classify_sentence_match

logger = logging.getLogger(__name__)

# Lowest overlaps any flag label in classify_sentence_match() accepts
# (common_academic_definition: word >= 0.18 or char >= 0.15).
_MIN_WORD_OVERLAP = 0.18
_MIN_CHAR_OVERLAP = 0.15

# Semantic similarity is only computed for the closest few lexical candidates
# of each sentence — the same idea as verify_match_sentences(top_k=3).
_CANDIDATES_PER_SENTENCE = 6

# Sentences shorter than this many words are not judged: "As shown in Table 2."
# overlaps everything and means nothing.
_MIN_SENTENCE_WORDS = 5

MAX_QUICK_CHECK_CHARS = 4000

# plagiarism_matcher.char_ngram_jaccard's default n.
_CHAR_NGRAM = 5

# Source-sentence embeddings, reused across checks (e5-small: 384 floats, so
# 20k entries is ~30 MB).
_EMBED_CACHE: "OrderedDict[str, Any]" = OrderedDict()
_EMBED_CACHE_SIZE = 20000
_EMBED_LOCK = threading.Lock()

_FLAG_LABELS = ("likely_plagiarism", "suspicious", "common_academic_definition")

# Per-report source sentences, so a user editing several passages of the same
# report doesn't reload and resplit every chunk file each time.
_CORPUS_CACHE: "OrderedDict[str, list[dict[str, Any]]]" = OrderedDict()
_CORPUS_CACHE_SIZE = 16
_CORPUS_LOCK = threading.Lock()


def _paper_ids_by_title(titles: set[str]) -> dict[str, str]:
    """Looks paper ids up by title in paper_cache's SQLite index.

    Reports restored from Supabase keep each match's source title but not its
    source_paper_id (document_matches has no such column), so this is how
    their chunk files are found again.
    """
    if not titles:
        return {}
    try:
        from paper_cache import DB_PATH, normalize_title
    except Exception:
        return {}
    if not os.path.exists(DB_PATH):
        return {}

    wanted = {normalize_title(t): t for t in titles if t}
    found: dict[str, str] = {}
    try:
        conn = sqlite3.connect(DB_PATH)
        try:
            for paper_id, title in conn.execute("SELECT paper_id, title FROM papers"):
                key = normalize_title(title or "")
                if key in wanted and wanted[key] not in found:
                    found[wanted[key]] = paper_id
        finally:
            conn.close()
    except Exception:
        logger.exception("Quick check: could not read the paper cache index.")
    return found


def _features(text: str) -> tuple[frozenset[str], frozenset[str]]:
    """Word set and 5-gram set exactly as plagiarism_matcher's
    word_jaccard_similarity / char_ngram_jaccard build them, computed once
    per sentence instead of once per comparison."""
    normalized = normalize_for_overlap(text)
    words = frozenset(normalized.split())
    compact = normalized.replace(" ", "")
    n = _CHAR_NGRAM
    grams = frozenset(compact[i:i + n] for i in range(len(compact) - n + 1)) if len(compact) >= n else frozenset()
    return words, grams


def _jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    return inter / (len(a) + len(b) - inter) if inter else 0.0


def _entry_features(entry: dict[str, Any]) -> tuple[frozenset[str], frozenset[str]]:
    """The entry's precomputed features, computed (once) if it has none."""
    if "_words" not in entry:
        entry["_words"], entry["_grams"] = _features(entry["text"])
    return entry["_words"], entry["_grams"]


def _sentence_entry(text: str, paper_id: str, title: str) -> dict[str, Any] | None:
    text = (text or "").strip()
    if len(text.split()) < _MIN_SENTENCE_WORDS:
        return None
    words, grams = _features(text)
    return {"text": text, "source_paper_id": paper_id, "source_title": title, "_words": words, "_grams": grams}


def build_source_corpus(report: dict[str, Any]) -> list[dict[str, Any]]:
    """Every source sentence this report can be compared against."""
    matches = report.get("matches") or []

    titles_by_id: dict[str, str] = {}
    titles_without_id: set[str] = set()
    for m in matches:
        paper_id = m.get("source_paper_id") or ""
        title = m.get("source_title") or ""
        if paper_id:
            titles_by_id.setdefault(paper_id, title)
        elif title:
            titles_without_id.add(title)
    for group in report.get("matched_papers") or []:
        paper_id = group.get("source_paper_id") or ""
        if paper_id:
            titles_by_id.setdefault(paper_id, group.get("source_title") or "")

    for title, paper_id in _paper_ids_by_title(titles_without_id).items():
        titles_by_id.setdefault(paper_id, title)

    corpus: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    def add(text: str, paper_id: str, title: str) -> None:
        entry = _sentence_entry(text, paper_id, title)
        if entry is None:
            return
        key = (paper_id or title, entry["text"])
        if key in seen:
            return
        seen.add(key)
        corpus.append(entry)

    for paper_id, title in titles_by_id.items():
        chunks = load_chunks_from_file(os.path.join(CHUNKS_DIR, paper_id + ".json"))
        for chunk in chunks:
            for span in split_sentences_with_spans(chunk.get("text", "")):
                add(span["text"], paper_id, title)

    # Fallback / complement: the matched source sentences themselves.
    for m in matches:
        add(
            m.get("source_sentence") or m.get("source_snippet") or "",
            m.get("source_paper_id") or "",
            m.get("source_title") or "",
        )

    return corpus


def _cached_corpus(report_id: str, report: dict[str, Any]) -> list[dict[str, Any]]:
    with _CORPUS_LOCK:
        cached = _CORPUS_CACHE.get(report_id)
        if cached is not None:
            _CORPUS_CACHE.move_to_end(report_id)
            return cached
    corpus = build_source_corpus(report)
    with _CORPUS_LOCK:
        _CORPUS_CACHE[report_id] = corpus
        _CORPUS_CACHE.move_to_end(report_id)
        while len(_CORPUS_CACHE) > _CORPUS_CACHE_SIZE:
            _CORPUS_CACHE.popitem(last=False)
    return corpus


def forget_report(report_id: str) -> None:
    """Drop a report's cached sources, e.g. after a re-check found new ones."""
    with _CORPUS_LOCK:
        _CORPUS_CACHE.pop(report_id, None)


def _encode(texts: list[str]) -> list[Any]:
    """One batched encode for every text a check needs (already prefixed
    with "query: " / "passage: " as embedding_model does)."""
    if not texts:
        return []
    import gpu_models
    import embedding_model  # noqa: F401  (registers the "e5" model)

    with gpu_models.use("e5") as model:
        vectors = gpu_models.retry_on_oom(lambda: model.encode(texts, normalize_embeddings=True))
    return list(vectors)


def _cosine(a: Any, b: Any) -> float:
    # Same formula as plagiarism_matcher.cosine_similarity.
    a = np.asarray(a)
    b = np.asarray(b)
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-8))


def _embed(queries: list[str], passages: list[str]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Embeddings for `queries` (the edited sentences) and `passages` (source
    sentences, cached across checks), computed in a single model call."""
    with _EMBED_LOCK:
        cached = {p: _EMBED_CACHE[p] for p in passages if p in _EMBED_CACHE}
        for p in cached:
            _EMBED_CACHE.move_to_end(p)
    missing = [p for p in dict.fromkeys(passages) if p not in cached]
    unique_queries = list(dict.fromkeys(queries))
    vectors = _encode(["query: " + q for q in unique_queries] + ["passage: " + p for p in missing])
    query_vecs = dict(zip(unique_queries, vectors[:len(unique_queries)]))
    new_passages = dict(zip(missing, vectors[len(unique_queries):]))
    with _EMBED_LOCK:
        for p, v in new_passages.items():
            _EMBED_CACHE[p] = v
        while len(_EMBED_CACHE) > _EMBED_CACHE_SIZE:
            _EMBED_CACHE.popitem(last=False)
    return query_vecs, {**cached, **new_passages}


def check_passage(text: str, corpus: list[dict[str, Any]]) -> dict[str, Any]:
    """Compares `text` (one passage, possibly several sentences) with `corpus`.

    Returns {"status": "clean"|"flagged", "hits": [...], "checked_sentences",
    "corpus_size"}. `hits` holds at most one hit per input sentence: its
    strongest flagged source sentence.
    """
    text = (text or "").strip()[:MAX_QUICK_CHECK_CHARS]
    sentences = [
        s["text"] for s in split_sentences_with_spans(text, min_chars=1)
        if len(s["text"].split()) >= _MIN_SENTENCE_WORDS
    ]
    # A short passage that is a single "sentence" below the word floor is
    # still judged as a whole, so a 4-word copied phrase isn't waved through.
    if not sentences and len(text.split()) >= 3:
        sentences = [text]

    # 1. Lexical pass (cheap): the closest few source sentences per sentence.
    shortlist: list[tuple[str, list[tuple[float, float, dict[str, Any]]]]] = []
    for sentence in sentences:
        words, grams = _features(sentence)
        candidates = []
        for entry in corpus:
            entry_words, entry_grams = _entry_features(entry)
            word = _jaccard(words, entry_words)
            char = _jaccard(grams, entry_grams)
            if word >= _MIN_WORD_OVERLAP or char >= _MIN_CHAR_OVERLAP:
                candidates.append((max(word, char), word, char, entry))
        candidates.sort(key=lambda c: c[0], reverse=True)
        shortlist.append((sentence, [(w, c, e) for _, w, c, e in candidates[:_CANDIDATES_PER_SENTENCE]]))

    # 2. Semantic pass: one batched model call for every pair that the
    #    overlap alone doesn't settle (>= 0.85 is "likely" without it).
    need_queries, need_passages = [], []
    for sentence, picks in shortlist:
        for word, char, entry in picks:
            if word < 0.85 and char < 0.85:
                need_queries.append(sentence)
                need_passages.append(entry["text"])
    query_vecs, passage_vecs = _embed(need_queries, need_passages) if need_queries else ({}, {})

    # 3. Classify with the full check's own rules.
    hits: list[dict[str, Any]] = []
    for sentence, picks in shortlist:
        best: dict[str, Any] | None = None
        for word, char, entry in picks:
            if word >= 0.85 or char >= 0.85:
                semantic = 1.0  # classify_sentence_match flags these on overlap alone
            else:
                semantic = _cosine(query_vecs[sentence], passage_vecs[entry["text"]])
            label = classify_sentence_match(
                semantic=semantic,
                word_overlap=word,
                char_overlap=char,
                input_sentence=sentence,
                source_sentence=entry["text"],
            )
            if label not in _FLAG_LABELS:
                continue
            hit = {
                "label": label,
                "weight": LABEL_WEIGHT.get(label, 0),
                "input_sentence": sentence,
                "source_sentence": entry["text"],
                "source_paper_id": entry["source_paper_id"],
                "source_title": entry["source_title"],
                "semantic_similarity": round(float(semantic), 4),
                "word_overlap": round(float(word), 4),
                "char_ngram_overlap": round(float(char), 4),
            }
            if best is None or (hit["weight"], hit["semantic_similarity"]) > (best["weight"], best["semantic_similarity"]):
                best = hit
        if best is not None:
            hits.append(best)

    return {
        "status": "flagged" if hits else "clean",
        "hits": hits,
        "checked_sentences": len(sentences),
        "corpus_size": len(corpus),
    }


def warm_up(report_id: str, report: dict[str, Any]) -> None:
    """Builds the report's corpus and loads the embedding model ahead of the
    first real check, so the reader's first edit doesn't wait ~10 s for it.
    Never raises (runs in a background thread)."""
    try:
        corpus = _cached_corpus(report_id, report)
        _encode(["query: warm up"])
        logger.info("Quick check warmed up for report_id=%s (%d source sentences).", report_id, len(corpus))
    except Exception:
        logger.exception("Quick check warm-up failed for report_id=%s", report_id)


def corpus_from_sources(sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Corpus from source sentences the client sent along (title + text).

    Used when the backend has no copy of the report (e.g. the document's id
    is the web app's placeholder because the backend could not persist the
    report): the matched source sentences the page already shows are still
    enough to tell whether an edit copies one of them.
    """
    corpus: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for source in sources:
        title = str(source.get("title") or "")
        for span in split_sentences_with_spans(str(source.get("text") or "")):
            entry = _sentence_entry(span["text"], "", title)
            if entry is None or (title, entry["text"]) in seen:
                continue
            seen.add((title, entry["text"]))
            corpus.append(entry)
    return corpus


def quick_check_report_passage(report_id: str, report: dict[str, Any], text: str) -> dict[str, Any]:
    """`check_passage` against the sources of `report` (cached per report)."""
    return check_passage(text, _cached_corpus(report_id, report))
