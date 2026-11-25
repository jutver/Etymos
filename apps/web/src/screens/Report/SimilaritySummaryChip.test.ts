import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MatchedSource } from "@etymos/shared";
import { describe, expect, it, vi } from "vitest";
import {
  SimilaritySummaryChip,
  SimilaritySummaryContent,
  summarizeSimilarity,
} from "./SimilaritySummaryChip";

function makeMatch(overrides: Partial<MatchedSource> & { id: string }): MatchedSource {
  return {
    severity: "moderate",
    detectionType: "traditional",
    matchPercent: 60,
    sourceTitle: "Sample Paper",
    sourceAuthor: "Jane Doe",
    sourceKind: "academic",
    citation: "Doe (2024)",
    userSnippet: "Repeated sentence",
    sourceSnippet: "Repeated sentence",
    explanation: "Matches phrase",
    rewriteSuggestions: [],
    ...overrides,
  };
}

describe("SimilaritySummaryChip", () => {
  it("summarizes severity, detection type, source kind, resolved counts, and top 5 unique sources", () => {
    const matches: MatchedSource[] = [
      makeMatch({ id: "m1", severity: "low", matchPercent: 40, sourceTitle: "Source A", sourceUrl: "https://a.test" }),
      makeMatch({ id: "m2", severity: "high", matchPercent: 88, sourceTitle: "Source A", sourceUrl: "https://a.test" }),
      makeMatch({ id: "m3", severity: "high", detectionType: "semantic", matchPercent: 95, sourceTitle: "Source B", sourceUrl: "https://b.test" }),
      makeMatch({ id: "m4", severity: "moderate", sourceKind: "web", matchPercent: 72, sourceTitle: "Source C", sourceUrl: "https://c.test" }),
      makeMatch({ id: "m5", severity: "low", matchPercent: 55, sourceTitle: "Source D", sourceUrl: "https://d.test" }),
      makeMatch({ id: "m6", severity: "low", matchPercent: 55, sourceTitle: "Source E", sourceUrl: "https://e.test" }),
      makeMatch({ id: "m7", severity: "low", matchPercent: 55, sourceTitle: "Source E", sourceUrl: "https://e.test" }),
      makeMatch({ id: "m8", severity: "low", matchPercent: 30, sourceTitle: "Source F", sourceUrl: "https://f.test" }),
    ];

    const summary = summarizeSimilarity(matches, new Set(["m1", "m4"]));

    expect(summary.countsBySeverity).toEqual({ high: 2, moderate: 1, low: 5 });
    expect(summary.countsByDetection).toEqual({ traditional: 7, semantic: 1 });
    expect(summary.countsByKind).toEqual({ academic: 7, web: 1 });
    expect(summary.resolvedCount).toBe(2);
    expect(summary.uniqueSourceCount).toBe(6);
    expect(summary.topSources.map((s) => s.title)).toEqual([
      "Source B",
      "Source A",
      "Source C",
      "Source E",
      "Source D",
    ]);
    expect(summary.topSources[1]).toMatchObject({
      highestPercent: 88,
      passageCount: 2,
      highestSeverity: "high",
      firstMatchId: "m1",
    });
  });

  it("renders a clickable top-bar button with similarity percentage and click-for-details tooltip", () => {
    const html = renderToStaticMarkup(
      createElement(SimilaritySummaryChip, {
        score: 34,
        wordCount: 1200,
        matches: [makeMatch({ id: "m1" })],
        resolvedIds: new Set<string>(),
      }),
    );

    expect(html).toContain('type="button"');
    expect(html).toContain("34% similar");
    expect(html).toContain("Similarity score 34% — click for details");
    expect(html).not.toContain('role="dialog"');

    const estimatedHtml = renderToStaticMarkup(
      createElement(SimilaritySummaryChip, {
        score: 21,
        estimated: true,
        wordCount: 1200,
        matches: [makeMatch({ id: "m1" })],
        resolvedIds: new Set<string>(),
      }),
    );
    expect(estimatedHtml).toContain("≈");
    expect(estimatedHtml).toContain("21% similar");
  });

  it("renders modal summary breakdown, top sources, locked semantic callout, and empty state", () => {
    const populatedHtml = renderToStaticMarkup(
      createElement(SimilaritySummaryContent, {
        score: 42,
        wordCount: 2500,
        matches: [
          makeMatch({ id: "m1", severity: "high", matchPercent: 92, sourceTitle: "Key Journal Article" }),
          makeMatch({ id: "m2", severity: "moderate", sourceKind: "web", matchPercent: 64, sourceTitle: "Web Reference" }),
        ],
        resolvedIds: new Set(["m2"]),
        lockedCount: 3,
        onUpgrade: vi.fn(),
        onClose: vi.fn(),
      }),
    );

    expect(populatedHtml).toContain("Similarity summary");
    expect(populatedHtml).toContain("Moderate similarity");
    expect(populatedHtml).toContain("42%");
    expect(populatedHtml).toContain("2,500 words analysed");
    expect(populatedHtml).toContain("Severity breakdown");
    expect(populatedHtml).toContain("Top matched sources");
    expect(populatedHtml).toContain("Key Journal Article");
    expect(populatedHtml).toContain("Web Reference");
    expect(populatedHtml).toContain("1 passage fixed");
    expect(populatedHtml).toContain("3 more found by Semantic Detection");

    const emptyHtml = renderToStaticMarkup(
      createElement(SimilaritySummaryContent, {
        score: 0,
        wordCount: 800,
        matches: [],
        resolvedIds: new Set<string>(),
        onClose: vi.fn(),
      }),
    );

    expect(emptyHtml).toContain("Clean");
    expect(emptyHtml).toContain("No matched sources");
    expect(emptyHtml).not.toContain("Top matched sources");
  });
});
