import { describe, expect, it } from "vitest";
import type { DocPassage, MatchedSource } from "@etymos/shared";
import { buildRenderedPassages } from "./highlights";
import { orderMatchesByDocumentPosition, sortMatchIndexes } from "./matchOrdering";

function makeMatch(id: string, over: Partial<MatchedSource> = {}): MatchedSource {
  return {
    id,
    severity: "high",
    detectionType: "traditional",
    matchPercent: 80,
    sourceTitle: `Source ${id}`,
    sourceAuthor: "Author",
    sourceKind: "academic",
    citation: id,
    userSnippet: "",
    sourceSnippet: "",
    explanation: "",
    rewriteSuggestions: [],
    ...over,
  };
}

function makePassage(id: string, text: string, over: Partial<DocPassage> = {}): DocPassage {
  return { id, text, ...over };
}

describe("orderMatchesByDocumentPosition", () => {
  it("orders historical reports without offsets strictly top-to-bottom via rendered passage spans", () => {
    const passages = [
      makePassage("p0", "First paragraph mentions alpha signal cleanly."),
      makePassage("p1", "Second paragraph opens with beta and closes with gamma."),
      makePassage("p2", "Third paragraph concludes with delta."),
    ];
    // Simulate DB rows returning in random / similarity-first order (delta=99, gamma=97, alpha=95, beta=90)
    const rawMatches = [
      makeMatch("m-delta", { matchPercent: 99, userSnippet: "concludes with delta" }),
      makeMatch("m-gamma", { matchPercent: 97, userSnippet: "closes with gamma" }),
      makeMatch("m-alpha", { matchPercent: 95, userSnippet: "mentions alpha signal" }),
      makeMatch("m-beta", { matchPercent: 90, userSnippet: "opens with beta" }),
    ];

    const rendered = buildRenderedPassages(passages, rawMatches);
    const ordered = orderMatchesByDocumentPosition(rawMatches, rendered);
    expect(ordered.map((m) => m.id)).toEqual(["m-alpha", "m-beta", "m-gamma", "m-delta"]);
  });

  it("orders multi-column passages following reading flow (left then right)", () => {
    const passages = [
      makePassage("p-left", "Left column lead sentence appears first.", { columnRole: "left", columnCount: 2 }),
      makePassage("p-right", "Right column sentence follows afterward.", { columnRole: "right", columnCount: 2 }),
    ];
    const matches = [
      makeMatch("m-right", { matchPercent: 98, userSnippet: "Right column sentence" }),
      makeMatch("m-left", { matchPercent: 85, userSnippet: "Left column lead" }),
    ];

    const rendered = buildRenderedPassages(passages, matches);
    expect(orderMatchesByDocumentPosition(matches, rendered).map((m) => m.id)).toEqual(["m-left", "m-right"]);
  });

  it("uses startOffset, pdfRects, sortOrder, then similarity for unlocated matches", () => {
    const matches = [
      makeMatch("unlocated-low", { matchPercent: 70 }),
      makeMatch("unlocated-high", { matchPercent: 96 }),
      makeMatch("pdf-page-2", { matchPercent: 99, pdfRects: [{ page: 2, x0: 40, y0: 100, x1: 200, y1: 120 }] }),
      makeMatch("pdf-page-1", { matchPercent: 80, pdfRects: [{ page: 1, x0: 40, y0: 300, x1: 200, y1: 320 }] }),
      makeMatch("offset-late", { startOffset: 220, endOffset: 260, matchPercent: 99 }),
      makeMatch("offset-early", { startOffset: 15, endOffset: 45, matchPercent: 75 }),
    ];

    const ordered = orderMatchesByDocumentPosition(matches, []);
    expect(ordered.map((m) => m.id)).toEqual([
      "offset-early",
      "offset-late",
      "pdf-page-1",
      "pdf-page-2",
      "unlocated-high",
      "unlocated-low",
    ]);
  });

  it("places merged overlapping spans at the covering span position", () => {
    const passages = [
      makePassage("p0", "Exact shared sentence sits at the top of page one."),
      makePassage("p1", "Another sentence sits lower on page one."),
    ];
    const matches = [
      makeMatch("m-lower", { matchPercent: 91, userSnippet: "sits lower on page one" }),
      makeMatch("m-merged", { matchPercent: 82, userSnippet: "Exact shared sentence" }),
      makeMatch("m-primary", { matchPercent: 98, userSnippet: "Exact shared sentence" }),
    ];

    const rendered = buildRenderedPassages(passages, matches);
    const ordered = orderMatchesByDocumentPosition(matches, rendered);
    expect(ordered.map((m) => m.id)).toEqual(["m-primary", "m-merged", "m-lower"]);
  });
});

describe("sortMatchIndexes", () => {
  const matches = [
    makeMatch("m0", { matchPercent: 72 }),
    makeMatch("m1", { matchPercent: 98 }),
    makeMatch("m2", { matchPercent: 85 }),
    makeMatch("m3", { matchPercent: 98 }),
  ];

  it("keeps document order in document mode and sorts descending by similarity in similarity mode", () => {
    expect(sortMatchIndexes([2, 0, 3, 1], matches, "document")).toEqual([0, 1, 2, 3]);
    expect(sortMatchIndexes([0, 1, 2, 3], matches, "similarity")).toEqual([1, 3, 2, 0]);
  });
});
