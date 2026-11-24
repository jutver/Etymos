import { describe, expect, it } from "vitest";
import type { DocPassage, MatchedSource } from "@etymos/shared";
import {
  AI_PDF_HIGHLIGHT,
  buildMatchFocusMap,
  buildRenderedPassages,
  chunkPassage,
  colorForMatch,
  colorForIndex,
  HEAVY_MATCH_PERCENT,
  HIGHLIGHT_COLORS,
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

  describe("a sentence that runs past a paragraph break", () => {
    const HEADING = "3.2 Pre-trained Word Vectors";
    const BODY = "Initializing word vectors with those obtained from an unsupervised model is popular.";
    // input_text joins blocks with "\n\n".
    const heading = { id: "h", text: HEADING, startOffset: 0, endOffset: HEADING.length } as DocPassage;
    const body = { id: "b", text: BODY, startOffset: HEADING.length + 2, endOffset: HEADING.length + 2 + BODY.length } as DocPassage;
    const SENTENCE = `${HEADING} ${BODY.slice(0, 41)}`;
    const texts = (rendered: ReturnType<typeof buildRenderedPassages>) =>
      rendered.map(({ passage: p, spans }) => spans.map((s) => [s.matchId, p.text.slice(s.start, s.end), s.approximate]));

    it("is highlighted in each passage by its offsets", () => {
      const across = match("across", null, { userSnippet: SENTENCE, startOffset: 0, endOffset: HEADING.length + 2 + 41 });
      expect(texts(buildRenderedPassages([heading, body], [across]))).toEqual([
        [["across", HEADING, false]],
        [["across", BODY.slice(0, 41), false]],
      ]);
    });

    it("is found by text when it has no offsets, instead of a whole-passage guess", () => {
      const across = match("across", null, { userSnippet: SENTENCE });
      const rendered = buildRenderedPassages([{ ...heading, matchId: "across" }, body], [across]);
      expect(texts(rendered)).toEqual([[["across", HEADING, false]], [["across", BODY.slice(0, 41), false]]]);
      expect(buildMatchFocusMap(rendered).get("across")).toBe("across");
    });

    it("is not drawn in passages its offsets don't cover", () => {
      const elsewhere = match("far", null, { userSnippet: SENTENCE, startOffset: 900, endOffset: 980 });
      expect(texts(buildRenderedPassages([heading, body], [elsewhere]))).toEqual([[], []]);
    });
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

function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHexRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(hexA: string, hexB: string): number {
  const l1 = relativeLuminance(hexA);
  const l2 = relativeLuminance(hexB);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("highlight palette WCAG AA contrast & viewer parity", () => {
  it("meets >= 4.5:1 WCAG AA contrast for every lighter mark token", () => {
    for (const token of [...HIGHLIGHT_COLORS, LIGHT_HIGHLIGHT]) {
      const bgMatch = token.mark.match(/\bbg-\[(#[0-9a-fA-F]{6})\]/);
      const textMatch = token.mark.match(/\btext-\[(#[0-9a-fA-F]{6})\]/);
      expect(bgMatch, `${token.key} missing bg-[#...]`).not.toBeNull();
      expect(textMatch, `${token.key} missing text-[#...]`).not.toBeNull();
      const bg = bgMatch![1]!;
      const fg = textMatch![1]!;
      expect(contrastRatio(bg, fg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(bg, "#0f172a")).toBeGreaterThanOrEqual(4.5);
      // Confirm lighter pastel backgrounds (high luminance > 0.85).
      expect(relativeLuminance(bg)).toBeGreaterThan(0.85);
      expect(token.mark, `${token.key} must not include dark: overrides in a light-only app`).not.toMatch(/\bdark:/);
    }
  });

  it("exposes unified pdf overlay tokens and soft AI wash for every source identity", () => {
    for (const token of [...HIGHLIGHT_COLORS, LIGHT_HIGHLIGHT]) {
      expect(token.chip).toMatch(/^bg-\[/);
      expect(token.pdf.fill).toMatch(/^rgba\(/);
      expect(token.pdf.fillActive).toMatch(/^rgba\(/);
      expect(token.pdf.accent).toMatch(/^rgba\(/);
    }
    expect(AI_PDF_HIGHLIGHT.fill).toMatch(/^rgba\(124, 58, 237,/);
    expect(AI_PDF_HIGHLIGHT.fillActive).toMatch(/^rgba\(124, 58, 237,/);
  });
});

describe("buildRenderedPassages at scale", () => {
  it("accurately locates 250 matches across 200 passages quickly with precompiled matchers and offset pruning", () => {
    const passages = Array.from({ length: 200 }, (_, i) => {
      const s1 = `Paragraph ${i} discusses transformer token optimization step one cleanly.`;
      const s2 = `Later in block ${i} a specific benchmark metric is computed identically.`;
      const text = `${s1} ${s2}`;
      const startOffset = i * 200;
      return {
        id: `p-${i}`,
        text,
        startOffset,
        endOffset: startOffset + text.length,
        matchId: i < 200 ? `m-${i}` : undefined,
      };
    });

    const matches = Array.from({ length: 250 }, (_, i) => {
      const pIdx = i % 200;
      const snippet =
        i < 200
          ? `Paragraph ${pIdx} discusses transformer token optimization step one cleanly.`
          : `specific benchmark metric is computed identically.`;
      const p = passages[pIdx]!;
      const localStart = p.text.indexOf(snippet);
      return {
        id: `m-${i}`,
        severity: "high" as const,
        detectionType: "traditional" as const,
        matchPercent: 98,
        sourceTitle: "Benchmark Paper",
        sourceAuthor: "Nguyen",
        sourceKind: "academic" as const,
        citation: "s2_1",
        userSnippet: snippet,
        sourceSnippet: snippet,
        explanation: "",
        rewriteSuggestions: [],
        startOffset: p.startOffset! + localStart,
        endOffset: p.startOffset! + localStart + snippet.length,
      };
    });

    const rendered = buildRenderedPassages(passages, matches);
    expect(rendered).toHaveLength(200);
    expect(rendered[0]!.spans.length).toBe(2);
    expect(rendered[199]!.spans.length).toBe(1);
  });
});
