// parseAiDetection maps the backend's snake_case `ai_detection` block to the
// UI type, and must never throw on old/odd data.
import { describe, expect, it } from "vitest";
import { aiLevelLabel, parseAiDetection, translateAiText } from "./aiDetection";
import { setLanguage } from "./i18n";

const backendBlock = {
  available: true,
  method: "lm_predictability_v1",
  model: "Qwen/Qwen2.5-1.5B-Instruct",
  overall_score: 72.5,
  level: "likely",
  confidence: "normal",
  language: "en",
  analyzed_words: 480,
  ai_share: 66.7,
  segments: [{ start: 0, end: 300, block_id: "abstract_0", words: 60, score: 88.2, excerpt: "Recent advances…" }],
  reasons: ["The wording is very predictable to a language model (perplexity ≈ 9)."],
  disclaimer: "This is a statistical estimate, not proof.",
};

describe("parseAiDetection", () => {
  it("maps a full backend block to camelCase", () => {
    expect(parseAiDetection(backendBlock)).toEqual({
      available: true,
      method: "lm_predictability_v1",
      model: "Qwen/Qwen2.5-1.5B-Instruct",
      overallScore: 72.5,
      level: "likely",
      confidence: "normal",
      language: "en",
      analyzedWords: 480,
      aiShare: 66.7,
      segments: [{ start: 0, end: 300, blockId: "abstract_0", words: 60, score: 88.2, excerpt: "Recent advances…" }],
      reasons: ["The wording is very predictable to a language model (perplexity ≈ 9)."],
      disclaimer: "This is a statistical estimate, not proof.",
    });
  });

  it("keeps 'detector could not run' distinct from 'no AI found'", () => {
    expect(parseAiDetection({ available: false, reason: "no GPU" })).toEqual({ available: false, reason: "no GPU" });
  });

  it("returns undefined for reports that predate the feature or malformed data", () => {
    for (const raw of [undefined, null, "x", 42, {}, { available: "yes" }]) {
      expect(parseAiDetection(raw)).toBeUndefined();
    }
  });

  it("degrades unknown level/confidence/segments instead of throwing", () => {
    const parsed = parseAiDetection({ available: true, level: "banana", segments: "nope", overall_score: "12" });
    expect(parsed).toMatchObject({ available: true, level: "low", confidence: "low", segments: [], overallScore: 12 });
  });
});

describe("aiLevelLabel", () => {
  it("has a plain-language label per level", () => {
    expect(aiLevelLabel("likely")).toBe("Likely AI-written");
    expect(aiLevelLabel("possible")).toBe("Possibly AI-assisted");
    expect(aiLevelLabel("low")).toBe("Mostly human-written");
  });
});

describe("translateAiText", () => {
  it("renders the backend's English reasons in Vietnamese, keeping the numbers", () => {
    setLanguage("vi");
    const predictable =
      "The wording is very predictable to a language model (perplexity ≈ 6, versus ≈ 18 for typical human academic writing); machine-written text tends to pick the most expected word.";
    expect(translateAiText(predictable)).toContain("perplexity ≈ 6");
    expect(translateAiText(predictable)).toContain("≈ 18");
    expect(translateAiText(predictable)).toMatch(/dễ đoán/);
    expect(translateAiText("55% of the words were the language model's single top guess, which is higher than usual for human writing.")).toMatch(/^55% số từ/);
    expect(translateAiText("About 39% of the analysed text sits in paragraphs that individually look machine-written.")).toMatch(/39%/);
    expect(translateAiText("No strong sign of machine-written text was found in the analysed paragraphs.")).toMatch(/Không tìm thấy/);
  });

  it("leaves English untouched in English and unknown text as-is in any language", () => {
    setLanguage("en");
    const reason = "About 39% of the analysed text sits in paragraphs that individually look machine-written.";
    expect(translateAiText(reason)).toBe(reason);
    setLanguage("vi");
    expect(translateAiText("Some future reason the UI has never seen.")).toBe("Some future reason the UI has never seen.");
    setLanguage("en");
  });
});
