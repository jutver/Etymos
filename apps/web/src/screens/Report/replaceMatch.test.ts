// "Accept & replace" on a merged highlight replaces just the card's sentence
// inside it (locateSnippet), and a typed-over highlight is shown as edited
// (isEditedHighlight). The DOM splitting itself runs in the browser only.
import { describe, expect, it } from "vitest";
import { isEditedHighlight, locateSnippet } from "./replaceMatch";

const merged =
  "We train a simple CNN with one layer of convolution.  The model uses\nstatic vectors (CNN-static) and performs well on benchmarks.";

describe("locateSnippet", () => {
  it("finds the card's sentence inside a merged highlight", () => {
    const snippet = "The model uses static vectors (CNN-static) and performs well on benchmarks.";
    const at = locateSnippet(merged, snippet);
    expect(at).not.toBeNull();
    expect(merged.slice(at!.start, at!.end)).toBe(
      "The model uses\nstatic vectors (CNN-static) and performs well on benchmarks.",
    );
  });

  it("ignores whitespace differences at the edges", () => {
    const at = locateSnippet(merged, "  We train a simple CNN  with one layer of convolution. ");
    expect(at).toEqual({ start: 0, end: merged.indexOf(".") + 1 });
  });

  it("refuses a cut-off snippet that starts or ends inside a word", () => {
    expect(locateSnippet(merged, "ic vectors (CNN-static) and performs")).toBeNull();
    expect(locateSnippet(merged, "The model uses static vectors (CNN-stat")).toBeNull();
  });

  it("refuses text that isn't in the highlight", () => {
    expect(locateSnippet(merged, "A sentence the reader already rewrote.")).toBeNull();
    expect(locateSnippet(merged, "   ")).toBeNull();
  });
});

describe("isEditedHighlight", () => {
  it("is false while the words are unchanged", () => {
    expect(isEditedHighlight("The model uses\nstatic  vectors.", "The model uses static vectors.")).toBe(false);
  });

  it("is true once a word changes", () => {
    expect(isEditedHighlight("The model relies on static vectors.", "The model uses static vectors.")).toBe(true);
  });
});
