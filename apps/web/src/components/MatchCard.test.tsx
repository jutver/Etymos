import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MotionConfig } from "motion/react";
import { describe, expect, it, vi } from "vitest";
import type { MatchedSource } from "@etymos/shared";
import { MatchCard } from "./MatchCard";

function sampleMatch(over: Partial<MatchedSource> = {}): MatchedSource {
  return {
    id: "m-1",
    severity: "high",
    detectionType: "traditional",
    matchPercent: 98,
    sourceTitle: "(PDF) ViHateT5: Enhancing Hate Speech Detection ... · Hugging FaceViHateT5",
    sourceAuthor: "Luan Thanh Nguyen",
    sourceKind: "academic",
    citation: "s2_1",
    userSnippet: "However, these efforts remain fragmented due to the reliance on separate fine-tuned models.",
    sourceSnippet: "However, these efforts remain fragmented due to the reliance on separate fine-tuned models.",
    explanation: "",
    rewriteSuggestions: [],
    sourceUrl: "https://arxiv.org/abs/2405.14141",
    ...over,
  };
}

describe("MatchCard", () => {
  it("renders sanitized source title, sequential badge number, and accessible disclosure trigger", () => {
    const html = renderToStaticMarkup(
      createElement(
        MotionConfig,
        { reducedMotion: "user" },
        createElement(MatchCard, {
          match: sampleMatch(),
          index: 0,
          onViewComparison: vi.fn(),
          onRewrite: vi.fn(),
          onCite: vi.fn(),
        }),
      ),
    );

    expect(html).toContain(">1<");
    expect(html).toContain("ViHateT5: Enhancing Hate Speech Detection");
    expect(html).not.toContain("Hugging Face");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="match-explanation-m-1"');
    expect(html).toContain("Why this is flagged");
  });

  it("renders locked teaser on free plan instead of the expandable explanation toggle", () => {
    const html = renderToStaticMarkup(
      createElement(MatchCard, {
        match: sampleMatch(),
        index: 2,
        locked: true,
        onViewComparison: vi.fn(),
        onRewrite: vi.fn(),
      }),
    );

    expect(html).toContain("Explanation available on paid plans");
    expect(html).not.toContain('aria-controls="match-explanation-m-1"');
  });
});
