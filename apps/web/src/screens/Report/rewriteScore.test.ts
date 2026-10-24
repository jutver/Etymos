import { describe, expect, it } from "vitest";
import type { MatchedSource } from "../../lib/types";
import type { QuickCheckHit } from "../../lib/api";
import { estimateScore, type PassageCheck } from "./rewriteScore";

function match(id: string, start: number, end: number, label = "likely_plagiarism"): MatchedSource {
  return {
    id,
    severity: "high",
    detectionType: "traditional",
    matchPercent: 90,
    sourceTitle: `Source ${id}`,
    sourceAuthor: "",
    sourceKind: "academic",
    citation: "",
    userSnippet: "x".repeat(end - start),
    sourceSnippet: "",
    explanation: "",
    rewriteSuggestions: [],
    startOffset: start,
    endOffset: end,
    explanationFacts: { kind: "verbatim", label, title: "", shared: 0, total: 0, phrase: "", semantic: 90 },
  };
}

function hit(sentence: string, weight = 1): QuickCheckHit {
  return {
    label: "likely_plagiarism",
    weight,
    input_sentence: sentence,
    source_sentence: sentence,
    source_paper_id: "p",
    source_title: "Other source",
    semantic_similarity: 0.95,
    word_overlap: 0.9,
    char_ngram_overlap: 0.9,
  };
}

// 300 + 100 weighted characters make up the whole 40% score: 1 char = 0.1 point.
const MATCHES = [match("long", 0, 300), match("short", 500, 600)];

describe("estimateScore", () => {
  it("leaves the stored score alone when nothing changed", () => {
    expect(estimateScore(40, MATCHES, new Set(), [])).toEqual({ score: 40, estimated: false, checking: false });
  });

  it("takes off each fixed passage's own share, not a flat amount", () => {
    expect(estimateScore(40, MATCHES, new Set(["long"]), []).score).toBe(10);
    expect(estimateScore(40, MATCHES, new Set(["short"]), []).score).toBe(30);
    expect(estimateScore(40, MATCHES, new Set(["long", "short"]), []).score).toBe(0);
  });

  it("counts one sentence matched by several sources once", () => {
    const twoSources = [...MATCHES, match("long-again", 0, 300)];
    expect(estimateScore(40, twoSources, new Set(["long"]), []).score).toBe(10);
  });

  it("counts partly overlapping spans once (union of characters)", () => {
    // 0-300 and 200-400 cover 400 characters, not 500.
    const overlapping = [match("a", 0, 300), match("b", 200, 400)];
    expect(estimateScore(40, overlapping, new Set(["a"]), []).score).toBe(20);
    expect(estimateScore(40, overlapping, new Set(["a", "b"]), []).score).toBe(0);
  });

  it("weighs a suspicious span at half a likely one", () => {
    const mixed = [match("a", 0, 100), match("b", 200, 300, "suspicious")];
    // weighted: 100 + 50 = 150 -> 30 points; fixing "b" removes 50/150 of it.
    expect(estimateScore(30, mixed, new Set(["b"]), []).score).toBe(20);
  });

  it("puts back what a still-flagged rewrite overlaps", () => {
    const check: PassageCheck = { matchIds: ["long"], text: "...", status: "flagged", hits: [hit("y".repeat(50))] };
    // 40 - 30 (old passage) + 5 (50 chars still copied)
    expect(estimateScore(40, MATCHES, new Set(["long"]), [check]).score).toBe(15);
  });

  it("keeps a passage's share until its quick check answers", () => {
    const checking: PassageCheck = { matchIds: ["short"], text: "...", status: "checking", hits: [] };
    expect(estimateScore(40, MATCHES, new Set(["short"]), [checking])).toEqual({
      score: 40,
      estimated: true,
      checking: true,
    });
    const clean: PassageCheck = { ...checking, status: "clean" };
    expect(estimateScore(40, MATCHES, new Set(["short"]), [clean]).score).toBe(30);
  });

  it("never counts a rewrite as worse than the passage it replaced", () => {
    const check: PassageCheck = { matchIds: ["short"], text: "...", status: "flagged", hits: [hit("y".repeat(5000))] };
    expect(estimateScore(40, MATCHES, new Set(["short"]), [check]).score).toBe(40);
  });

  it("never goes below 0", () => {
    expect(estimateScore(40, MATCHES, new Set(["long", "short"]), []).score).toBe(0);
  });
});
