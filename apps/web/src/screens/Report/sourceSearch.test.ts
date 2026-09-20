import { describe, expect, it } from "vitest";
import type { MatchedSource } from "@etymos/shared";
import { buildSearchIndex, filterMatchIndexes, normalizeForSearch } from "./sourceSearch";

function match(overrides: Partial<MatchedSource>): MatchedSource {
  return {
    id: "m",
    severity: "high",
    detectionType: "traditional",
    matchPercent: 96,
    sourceTitle: "",
    sourceAuthor: "",
    sourceKind: "academic",
    citation: "",
    userSnippet: "",
    sourceSnippet: "",
    explanation: "",
    rewriteSuggestions: [],
    ...overrides,
  } as MatchedSource;
}

const MATCHES = [
  match({ id: "a", sourceTitle: "ViHateT5: Enhancing Hate Speech Detection", sourceAuthor: "Luan Thanh Nguyen", sourceKind: "academic" }),
  match({ id: "b", sourceTitle: "Hate speech on social media", sourceAuthor: "Trần Đức Anh", sourceKind: "web", matchPercent: 91 }),
  match({ id: "c", sourceTitle: "Sentiment analysis survey", userSnippet: "transformer-based language models", sourceYear: "2021" }),
];
const INDEX = buildSearchIndex(MATCHES);

describe("normalizeForSearch", () => {
  it("lower-cases and strips Vietnamese diacritics, including đ", () => {
    expect(normalizeForSearch("Nguyễn Đức Trần")).toBe("nguyen duc tran");
  });
});

describe("filterMatchIndexes", () => {
  it("returns every index for an empty or whitespace-only query", () => {
    expect(filterMatchIndexes(INDEX, "")).toEqual([0, 1, 2]);
    expect(filterMatchIndexes(INDEX, "   ")).toEqual([0, 1, 2]);
  });

  it("finds by title, case-insensitively", () => {
    expect(filterMatchIndexes(INDEX, "HATE")).toEqual([0, 1]);
  });

  it("finds by author without needing diacritics", () => {
    expect(filterMatchIndexes(INDEX, "tran duc")).toEqual([1]);
    expect(filterMatchIndexes(INDEX, "nguyen")).toEqual([0]);
  });

  it("requires every term (in any order)", () => {
    expect(filterMatchIndexes(INDEX, "speech hate")).toEqual([0, 1]);
    expect(filterMatchIndexes(INDEX, "hate survey")).toEqual([]);
  });

  it("also searches the matched text, year, source kind and percentage", () => {
    expect(filterMatchIndexes(INDEX, "transformer-based")).toEqual([2]);
    expect(filterMatchIndexes(INDEX, "2021")).toEqual([2]);
    expect(filterMatchIndexes(INDEX, "web")).toEqual([1]);
    expect(filterMatchIndexes(INDEX, "91%")).toEqual([1]);
  });

  it("returns positions in the original list so badge numbers don't shift", () => {
    expect(filterMatchIndexes(INDEX, "survey")).toEqual([2]); // position 2, not 0
  });

  it("returns nothing when no match contains the term", () => {
    expect(filterMatchIndexes(INDEX, "zzzz")).toEqual([]);
  });
});
