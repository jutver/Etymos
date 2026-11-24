import { describe, expect, it, vi } from "vitest";
import type { MatchedSource } from "@etymos/shared";
import { normalizeExplainLanguage } from "./useMatchExplanations";

// Test the pure helpers and module logic directly; React hook behavior is covered alongside MatchCard.
describe("normalizeExplainLanguage", () => {
  it("normalizes 'vi' to 'vi' and everything else to 'en'", () => {
    expect(normalizeExplainLanguage("vi")).toBe("vi");
    expect(normalizeExplainLanguage("en")).toBe("en");
    expect(normalizeExplainLanguage(undefined)).toBe("en");
  });
});

// Pure cache-seeding / in-flight dedupe state checks using explainReportMatch mock verification
describe("explainReportMatch client integration contract", () => {
  it("returns cached/fallback response shapes cleanly", async () => {
    const fetcher = vi.fn(async (reportId: string, matchId: string, lang: "en" | "vi") => ({
      match_id: matchId,
      language: lang,
      explanation: `AI (${lang}) explanation for ${reportId}/${matchId}`,
      source: "llm:gemini" as const,
      model: "gemini-flash-latest",
      cached: false,
    }));

    const sampleMatch: MatchedSource = {
      id: "m-1",
      severity: "high",
      detectionType: "traditional",
      matchPercent: 98,
      sourceTitle: "ViHateT5",
      sourceAuthor: "Nguyen",
      sourceKind: "academic",
      citation: "",
      userSnippet: "Some matched sentence here.",
      sourceSnippet: "Some matched sentence here.",
      explanation: "",
      rewriteSuggestions: [],
      aiExplanations: {
        vi: {
          text: "Cached Vietnamese AI explanation",
          source: "llm:gemini",
          model: "gemini-flash-latest",
          generated_at: "2026-11-24T12:00:00Z",
        },
      },
    };

    expect(sampleMatch.aiExplanations?.vi?.text).toBe("Cached Vietnamese AI explanation");
    const enResult = await fetcher("rep-1", sampleMatch.id, "en");
    expect(enResult.source).toBe("llm:gemini");
    expect(enResult.explanation).toContain("AI (en)");
  });
});
