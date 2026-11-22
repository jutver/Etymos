import { describe, expect, it } from "vitest";
import { extractWordTokens, findFuzzyMatch, locateSnippetRaw } from "./textMatch";

describe("textMatch findFuzzyMatch", () => {
  it("locates an exact normalized match cleanly", () => {
    const raw = "Intro text. Convolutional neural networks classify sentences accurately. Trailing.";
    const located = locateSnippetRaw(raw, "Convolutional neural networks classify sentences accurately.");
    expect(located).not.toBeNull();
    expect(raw.slice(located!.rawStart, located!.rawEnd)).toBe(
      "Convolutional neural networks classify sentences accurately.",
    );
  });

  it("matches snippets starting with stopwords by anchoring on distinctive content words", () => {
    const page =
      "in the introduction we note that of all the models convolutional neural networks outperform baselines";
    const tokens = extractWordTokens(page);
    const snippet = ["in", "the", "of", "convolutional", "neural", "networks"];
    const hit = findFuzzyMatch(tokens, snippet);
    expect(hit).not.toBeNull();
    const matched = page.slice(hit!.start, hit!.end + 1);
    expect(matched).toContain("convolutional");
    expect(matched).toContain("networks");
  });

  it("tolerates missing or corrupted words while rejecting unrelated pages", () => {
    const page = "some totally unrelated text about ocean tides and lunar gravity cycles";
    const tokens = extractWordTokens(page);
    expect(findFuzzyMatch(tokens, ["convolutional", "neural", "networks", "classify", "sentences"])).toBeNull();

    const noisy = "convolutional neural network models classify sentence embeddings";
    const hit = findFuzzyMatch(extractWordTokens(noisy), [
      "convolutional",
      "neural",
      "networks",
      "classify",
      "sentence",
    ]);
    expect(hit).not.toBeNull();
  });
});
