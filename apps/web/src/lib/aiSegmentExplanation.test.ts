import { describe, expect, it } from "vitest";
import { AI_DETECTION_SOURCES, explainAiSegment } from "./aiSegmentExplanation";

const base = { start: 0, end: 10, words: 80, score: 85 };

describe("explainAiSegment", () => {
  it("explains a machine-like paragraph from its three measurements, with sources", () => {
    const points = explainAiSegment({ ...base, features: { meanNll: 1.75, topOneShare: 0.57, sentenceSpread: 0.52 } });
    expect(points).toHaveLength(3);
    expect(points[0]!.text).toContain("≈ 6");
    expect(points[0]!.sources).toEqual([1, 2]);
    expect(points[1]!.text).toContain("57%");
    expect(points[1]!.sources).toEqual([3]);
  });

  it("falls back to the score for reports without stored measurements", () => {
    const points = explainAiSegment(base);
    expect(points).toHaveLength(1);
    expect(points[0]!.text).toContain("85%");
  });

  it("only cites sources that exist", () => {
    const ids = new Set(AI_DETECTION_SOURCES.map((s) => s.id));
    const cited = explainAiSegment({ ...base, features: { meanNll: 3.5, topOneShare: 0.3, sentenceSpread: 1 } })
      .flatMap((p) => p.sources);
    expect(cited.every((id) => ids.has(id))).toBe(true);
  });
});
