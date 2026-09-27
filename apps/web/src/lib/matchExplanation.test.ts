import { afterEach, describe, expect, it } from "vitest";
import type { MatchedSource } from "@etymos/shared";
import { setLanguage } from "./i18n";
import { explainMatch, parseExplanationFacts } from "./matchExplanation";

const match = (over: Partial<MatchedSource> = {}): MatchedSource => ({
  id: "m1", severity: "high", detectionType: "semantic", matchPercent: 83,
  sourceTitle: "ViHateT5", sourceAuthor: "", sourceKind: "academic", citation: "",
  userSnippet: "", sourceSnippet: "", explanation: "Stored text from the backend.", rewriteSuggestions: [],
  ...over,
});

const facts = parseExplanationFacts({
  kind: "phrase", label: "likely_plagiarism", title: "ViHateT5", shared: 5, total: 12, phrase: "hate speech detection in Vietnamese", semantic: 83,
});

afterEach(() => setLanguage("en"));

describe("explainMatch", () => {
  it("writes the explanation in the UI language from the facts", () => {
    setLanguage("en");
    const en = explainMatch(match({ explanationFacts: facts }));
    expect(en).toContain('the source "ViHateT5" share the phrase "hate speech detection in Vietnamese"');
    expect(en).toContain("83% similar in meaning");
    expect(en).toContain("strongest matches");

    setLanguage("vi");
    const vi = explainMatch(match({ explanationFacts: facts }));
    expect(vi).toContain('nguồn "ViHateT5" có chung cụm "hate speech detection in Vietnamese"');
    expect(vi).toContain("83% về nghĩa");
  });

  it("shows the stored text when there are no facts (LLM text, old reports)", () => {
    expect(explainMatch(match())).toBe("Stored text from the backend.");
  });

  it("ignores facts it does not understand", () => {
    expect(parseExplanationFacts({ kind: "nonsense" })).toBeUndefined();
    expect(parseExplanationFacts(null)).toBeUndefined();
  });
});

describe("explainMatch on reports saved before explanation facts", () => {
  it("reads the facts back out of the stored English text and answers in Vietnamese", () => {
    const stored =
      'Your text and the source "ViHateT5" share the phrase "hate speech" (5 words in a row), and the sentence as a whole is 88% similar in meaning. Reword the surrounding sentence, or quote and cite the source. It deserves a closer look.';
    setLanguage("vi");
    const vi = explainMatch(match({ explanation: stored }));
    expect(vi).toContain('nguồn "ViHateT5" có chung cụm "hate speech" (5 từ liên tiếp)');
    expect(vi).toContain("88% về nghĩa");
    expect(vi).toContain("Cần xem xét kỹ hơn.");
  });

  it("reads stored Vietnamese text and answers in English", () => {
    const stored =
      "Từ ngữ khác với nguồn, nhưng ý nghĩa giống 72% và câu đi theo đúng cấu trúc của nguồn. Kiểu diễn đạt lại sát như vậy vẫn bị đánh dấu: hãy tổ chức lại câu theo cách riêng của bạn và trích dẫn nguồn.";
    setLanguage("en");
    expect(explainMatch(match({ explanation: stored }))).toBe(
      "The wording differs from the source, but the meaning is 72% the same and the sentence follows the source's structure. Close paraphrases like this are still flagged: restructure the sentence in your own way and cite the source.",
    );
  });
});
