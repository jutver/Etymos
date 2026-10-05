import { describe, expect, it } from "vitest";
import type { DocPassage } from "@etymos/shared";
import { mapAiSegmentsToPassages } from "./highlights";

const PARA_A = "Recent advancements in hate speech detec- tion have made significant progress in many languages.";
const PARA_B = "The second paragraph talks about something else entirely and is not flagged.";

function passage(id: string, text: string, extra: Partial<DocPassage> = {}): DocPassage {
  return { id, text, ...extra } as DocPassage;
}

describe("mapAiSegmentsToPassages", () => {
  it("maps by offsets when passages have them", () => {
    const passages = [
      passage("a", PARA_A, { startOffset: 0, endOffset: 100 }),
      passage("b", PARA_B, { startOffset: 102, endOffset: 180 }),
    ];
    const map = mapAiSegmentsToPassages(passages, [{ id: "s1", start: 102, end: 180 }]);
    expect(map.get("s1")).toBe("b");
  });

  it("falls back to the excerpt when passages were reloaded without offsets", () => {
    const passages = [passage("a", PARA_A), passage("b", PARA_B)];
    const map = mapAiSegmentsToPassages(passages, [
      // Backend excerpt: hyphen break re-joined, truncated with an ellipsis.
      { id: "s1", start: 0, end: 100, excerpt: "Recent advancements in hate speech detection have made…" },
    ]);
    expect(map.get("s1")).toBe("a");
  });

  it("matches ligatures folded by NFKC", () => {
    const passages = [passage("a", "We deﬁne a deadline-feasible rule for the scheduler here.")];
    const map = mapAiSegmentsToPassages(passages, [
      { id: "s1", start: 0, end: 10, excerpt: "We define a deadline-feasible rule" },
    ]);
    expect(map.get("s1")).toBe("a");
  });

  it("skips headings and excerpts too short to be told apart", () => {
    const passages = [passage("h", PARA_B, { blockType: "heading" }), passage("b", PARA_B)];
    const map = mapAiSegmentsToPassages(passages, [
      { id: "s1", start: 0, end: 1, excerpt: "The second paragraph talks" },
      { id: "s2", start: 0, end: 1, excerpt: "short" },
    ]);
    expect(map.get("s1")).toBe("b");
    expect(map.has("s2")).toBe(false);
  });
});
