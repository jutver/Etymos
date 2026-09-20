import { describe, expect, it } from "vitest";
import type { DocPassage, MatchedSource } from "@etymos/shared";
import {
  buildMatchFocusMap,
  buildRenderedPassages,
  chunkPassage,
  colorForMatch,
  colorForIndex,
  HEAVY_MATCH_PERCENT,
  LIGHT_HIGHLIGHT,
  matchTone,
} from "./highlights";

// Helpers for the two tones, so tests don't hard-code the cutoff.
const HEAVY = HEAVY_MATCH_PERCENT + 2;
const LIGHT = HEAVY_MATCH_PERCENT - 5;

const TEXT = "First copied sentence. A merely similar sentence. Original words here.";
const FIRST = { start: 0, end: 22 }; // "First copied sentence."
const SECOND = { start: 23, end: 49 }; // "A merely similar sentence."

function passage(overrides: Partial<DocPassage> = {}): DocPassage {
  return { id: "p1", text: TEXT, startOffset: 0, endOffset: TEXT.length, ...overrides } as DocPassage;
}

function match(id: string, range: { start: number; end: number } | null, overrides: Partial<MatchedSource> = {}): MatchedSource {
  const snippet = range ? TEXT.slice(range.start, range.end) : "";
  return {
    id,
    severity: "high",
    detectionType: "traditional",
    matchPercent: HEAVY,
    sourceTitle: "Source",
    sourceAuthor: "",
    sourceKind: "academic",
    citation: "",
    userSnippet: snippet,
    sourceSnippet: snippet,
    explanation: "",
    rewriteSuggestions: [],
    ...(range ? { startOffset: range.start, endOffset: range.end } : {}),
    ...overrides,
  } as MatchedSource;
}

describe("matchTone / colorForMatch", () => {
  it("treats matches below the cutoff as light and at/above it as heavy", () => {
    expect(matchTone({ matchPercent: HEAVY_MATCH_PERCENT - 1 })).toBe("light");
    expect(matchTone({ matchPercent: HEAVY_MATCH_PERCENT })).toBe("heavy");
    expect(matchTone({ matchPercent: 99 })).toBe("heavy");
  });

  it("uses the rotating palette for heavy and light pink for light", () => {
    expect(colorForMatch({ matchPercent: HEAVY }, 3)).toBe(colorForIndex(3));
    expect(colorForMatch({ matchPercent: LIGHT }, 3)).toBe(LIGHT_HIGHLIGHT);
  });
});

describe("buildRenderedPassages", () => {
  it("highlights every matched sentence in a passage, not just the first", () => {
    const heavy = match("m1", FIRST, { matchPercent: HEAVY });
    const light = match("m2", SECOND, { matchPercent: LIGHT });

    // passage.matchId points at only one of them — the other used to be dropped.
    const [rendered] = buildRenderedPassages([passage({ matchId: "m1" })], [heavy, light]);

    expect(rendered.spans.map((s) => [s.matchId, s.start, s.end, s.tone])).toEqual([
      ["m1", FIRST.start, FIRST.end, "heavy"],
      ["m2", SECOND.start, SECOND.end, "light"],
    ]);
  });

  it("finds secondary matches even when the passage has no matchId (restored report)", () => {
    const [rendered] = buildRenderedPassages(
      [passage()],
      [match("m1", FIRST), match("m2", SECOND)],
    );
    expect(rendered.spans.map((s) => s.matchId)).toEqual(["m1", "m2"]);
  });

  it("collapses matches on the same words to the strongest one", () => {
    const light = match("light", FIRST, { matchPercent: LIGHT });
    const heavy = match("heavy", FIRST, { matchPercent: 99 });

    const [rendered] = buildRenderedPassages([passage()], [light, heavy]);

    expect(rendered.spans).toHaveLength(1);
    expect(rendered.spans[0]).toMatchObject({ matchId: "heavy", tone: "heavy" });
  });

  it("skips matches whose offsets lie outside the passage", () => {
    const elsewhere = match("far", { start: 500, end: 522 }, { userSnippet: "First copied sentence." });
    const [rendered] = buildRenderedPassages([passage()], [elsewhere]);
    expect(rendered.spans).toEqual([]);
  });

  it("re-anchors by text when offsets drift (e.g. the passage was trimmed)", () => {
    // Passage text lost 3 leading chars relative to its recorded start offset.
    const trimmed = passage({ text: TEXT.slice(3), startOffset: 0, endOffset: TEXT.length });
    const [rendered] = buildRenderedPassages([trimmed], [match("m1", SECOND)]);

    const span = rendered.spans[0];
    expect(trimmed.text.slice(span.start, span.end)).toBe(TEXT.slice(SECOND.start, SECOND.end));
  });

  it("falls back to text search for offset-less matches and never guesses a whole passage for them", () => {
    const found = match("found", null, { userSnippet: "A merely similar sentence." });
    const missing = match("missing", null, { userSnippet: "text that is not in here at all" });

    const [rendered] = buildRenderedPassages([passage()], [found, missing]);

    expect(rendered.spans.map((s) => s.matchId)).toEqual(["found"]);
  });

  it("lets a precise span beat an approximate whole-passage primary", () => {
    const primary = match("primary", null, { userSnippet: "unlocatable snippet" });
    const precise = match("precise", SECOND);

    const [rendered] = buildRenderedPassages([passage({ matchId: "primary" })], [primary, precise]);

    expect(rendered.spans.map((s) => s.matchId)).toEqual(["precise"]);
  });

  it("still highlights the whole passage for an unlocatable primary when nothing else matches", () => {
    const primary = match("primary", null, { userSnippet: "unlocatable snippet" });
    const [rendered] = buildRenderedPassages([passage({ matchId: "primary" })], [primary]);

    expect(rendered.spans).toHaveLength(1);
    expect(rendered.spans[0]).toMatchObject({ matchId: "primary", approximate: true, start: 0, end: TEXT.length });
  });
});

describe("buildMatchFocusMap", () => {
  it("maps a highlighted match to itself and a merged one to the highlight covering it", () => {
    const winner = match("winner", FIRST, { matchPercent: 99 });
    const loser = match("loser", FIRST, { matchPercent: LIGHT }); // same words, weaker
    const other = match("other", SECOND);

    const rendered = buildRenderedPassages([passage()], [winner, loser, other]);
    const focus = buildMatchFocusMap(rendered);

    expect(focus.get("winner")).toBe("winner");
    expect(focus.get("other")).toBe("other");
    // The loser has no highlight of its own, but selecting it must still land on the winner's.
    expect(focus.get("loser")).toBe("winner");
  });

  it("records merged ids on the surviving span", () => {
    const [rendered] = buildRenderedPassages(
      [passage()],
      [match("a", FIRST, { matchPercent: 99 }), match("b", FIRST, { matchPercent: LIGHT })],
    );
    expect(rendered.spans).toHaveLength(1);
    expect(rendered.spans[0].mergedIds).toEqual(["b"]);
  });

  it("omits matches that could not be located anywhere", () => {
    const stray = match("stray", null, { userSnippet: "text that is nowhere in this passage" });
    const focus = buildMatchFocusMap(buildRenderedPassages([passage()], [match("m1", FIRST), stray]));

    expect(focus.has("m1")).toBe(true);
    expect(focus.has("stray")).toBe(false);
  });

  it("prefers a match's own highlight over being merged elsewhere", () => {
    const rendered = buildRenderedPassages(
      [passage()],
      [match("m1", FIRST), match("m2", SECOND)],
    );
    const focus = buildMatchFocusMap(rendered);
    expect([...focus.entries()]).toEqual([
      ["m1", "m1"],
      ["m2", "m2"],
    ]);
  });
});

describe("chunkPassage", () => {
  it("carries each span's tone onto its chunk", () => {
    const [rendered] = buildRenderedPassages(
      [passage()],
      [match("m1", FIRST, { matchPercent: HEAVY }), match("m2", SECOND, { matchPercent: LIGHT })],
    );

    const marked = chunkPassage(TEXT, rendered.spans).filter((c) => c.matchId);
    expect(marked.map((c) => [c.matchId, c.tone])).toEqual([
      ["m1", "heavy"],
      ["m2", "light"],
    ]);
  });
});
