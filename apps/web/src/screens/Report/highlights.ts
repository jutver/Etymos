import type { DocPassage, MatchedSource } from "@etymos/shared";

/**
 * Highlight palette for matched passages.
 *
 * The user asked for *multiple colors* rather than a severity shade ramp, so a
 * match's colour is purely an identity token — it says "this highlight and that
 * sidebar card are the same match", not "this is bad". Severity is still shown,
 * but as text/tag inside the sidebar card where it can be read properly.
 *
 * Accessibility: colour is never the only signal. Every mark also carries a
 * dotted underline plus a superscript index badge that matches the number on
 * the sidebar card, so the mapping survives greyscale, colour-blindness and
 * high-contrast modes. Each entry ships a light and a dark treatment; the web
 * app is currently `color-scheme: light` only, so the `dark:` classes are
 * inert today but keep the palette correct if a dark theme lands later.
 */
export interface HighlightColor {
  key: string;
  /** Human-readable name, used in tooltips + screen-reader labels. */
  label: string;
  /** Classes for the <mark> inside the document. */
  mark: string;
  /** Small solid swatch used on the sidebar card + legend. */
  chip: string;
}

export const HIGHLIGHT_COLORS: HighlightColor[] = [
  {
    key: "amber",
    label: "Amber",
    mark: "bg-[#fdf0c9] text-[#5a4408] decoration-[#b45309] dark:bg-[#5a4408] dark:text-[#fdf0c9] dark:decoration-[#fbbf24]",
    chip: "bg-[#eab308]",
  },
  {
    key: "rose",
    label: "Rose",
    mark: "bg-[#fde0e4] text-[#7f1d3a] decoration-[#be123c] dark:bg-[#5c1024] dark:text-[#fde0e4] dark:decoration-[#fb7185]",
    chip: "bg-[#e11d48]",
  },
  {
    key: "violet",
    label: "Violet",
    mark: "bg-[#e9e2fd] text-[#4c1d95] decoration-[#7c3aed] dark:bg-[#3b1e75] dark:text-[#e9e2fd] dark:decoration-[#a78bfa]",
    chip: "bg-[#7c3aed]",
  },
  {
    key: "teal",
    label: "Teal",
    mark: "bg-[#cdf3ea] text-[#0f4f45] decoration-[#0d9488] dark:bg-[#0c3b34] dark:text-[#cdf3ea] dark:decoration-[#2dd4bf]",
    chip: "bg-[#0d9488]",
  },
  {
    key: "sky",
    label: "Sky",
    mark: "bg-[#d9e8fe] text-[#1e3a8a] decoration-[#2563eb] dark:bg-[#10315e] dark:text-[#d9e8fe] dark:decoration-[#60a5fa]",
    chip: "bg-[#2563eb]",
  },
  {
    key: "lime",
    label: "Lime",
    mark: "bg-[#e6f5c8] text-[#3f5c0c] decoration-[#65a30d] dark:bg-[#2f4110] dark:text-[#e6f5c8] dark:decoration-[#a3e635]",
    chip: "bg-[#65a30d]",
  },
];

export function colorForIndex(index: number): HighlightColor {
  return HIGHLIGHT_COLORS[index % HIGHLIGHT_COLORS.length];
}

/** One resolved highlight range inside a single passage's text. */
export interface PassageSpan {
  matchId: string;
  /** Character offset into `passage.text`, inclusive. */
  start: number;
  /** Character offset into `passage.text`, exclusive. */
  end: number;
  /** True when we could not localise the snippet and fell back to the whole
   *  passage. Surfaced so the UI can soften the highlight instead of lying
   *  about precision. */
  approximate: boolean;
}

export interface RenderedPassage {
  passage: DocPassage;
  spans: PassageSpan[];
}

// ---------------------------------------------------------------------------
// CLIENT-SIDE OFFSET DERIVATION — LEGACY FALLBACK
// ---------------------------------------------------------------------------
// The backend now returns real character offsets on each match
// (`MatchedSource.startOffset` / `endOffset`, absolute into the report's
// `input_text`), and `resolveSpan` below prefers them. Everything in this
// section is the fallback for inputs that have no offsets:
//
//   * reports generated before the backend emitted `input_offset`, including
//     every report already persisted in Supabase (whose passage/match rows
//     have no offset columns), and
//   * individual matches the backend could not localise — it omits
//     `input_offset` rather than zeroing it, so those arrive offset-less
//     inside an otherwise modern report.
//
// Both are still live paths, so this heuristic stays. It is only *gated* now,
// not replaced.
//
// Strategy, cheapest first:
//   1. Exact substring hit.
//   2. Whitespace-insensitive hit (PDF extraction loves stray newlines and
//      double spaces, so the snippet often differs from the passage only in
//      run-length of whitespace).
//   3. Anchor on the snippet's first and last few words and take the range
//      between them.
//   4. Give up and highlight the whole passage, flagged `approximate`.
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Builds a regex that matches `snippet` ignoring differences in whitespace runs. */
function whitespaceInsensitivePattern(snippet: string): RegExp | null {
  const words = snippet.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return new RegExp(words.map(escapeRegExp).join("\\s+"), "i");
}

function anchorRange(passageText: string, snippet: string): { start: number; end: number } | null {
  const words = snippet.trim().split(/\s+/).filter(Boolean);
  if (words.length < 4) return null;

  const head = whitespaceInsensitivePattern(words.slice(0, Math.min(5, words.length)).join(" "));
  const tail = whitespaceInsensitivePattern(words.slice(-Math.min(5, words.length)).join(" "));
  if (!head || !tail) return null;

  const headHit = head.exec(passageText);
  if (!headHit) return null;

  // Search for the tail only after the head so we never produce an inverted range.
  const afterHead = passageText.slice(headHit.index);
  const tailHit = tail.exec(afterHead);
  if (!tailHit) return null;

  const start = headHit.index;
  const end = headHit.index + tailHit.index + tailHit[0].length;
  return end > start ? { start, end } : null;
}

/** Resolve where `snippet` sits inside `passageText`. Returns null when unlocatable. */
export function locateSnippetInPassage(
  passageText: string,
  snippet: string,
): { start: number; end: number } | null {
  const trimmed = snippet.trim();
  if (!trimmed) return null;

  const exact = passageText.indexOf(trimmed);
  if (exact !== -1) return { start: exact, end: exact + trimmed.length };

  const loose = whitespaceInsensitivePattern(trimmed);
  if (loose) {
    const hit = loose.exec(passageText);
    if (hit) return { start: hit.index, end: hit.index + hit[0].length };
  }

  return anchorRange(passageText, trimmed);
}

/**
 * Rebases the backend's absolute offsets onto a single passage.
 *
 * `match.startOffset` / `endOffset` index the report's whole `input_text`;
 * `passage.startOffset` is that same passage's origin in it. Subtracting gives
 * the passage-local range the renderer wants.
 *
 * Returns null unless *all* of the following hold, in which case the caller
 * falls back to the text-search heuristic:
 *   - both sides actually carry offsets (historical reports carry neither),
 *   - the range is well-formed, and
 *   - it lies inside this passage.
 * The bounds check matters because passage splitting and match localisation
 * are independent: a match straddling a paragraph break has no single passage
 * that contains it, and clamping would draw a confidently-wrong highlight.
 */
function offsetsWithinPassage(
  passage: DocPassage,
  match: MatchedSource,
): { start: number; end: number } | null {
  const { startOffset: matchStart, endOffset: matchEnd } = match;
  const { startOffset: passageStart, endOffset: passageEnd } = passage;
  if (matchStart == null || matchEnd == null || passageStart == null || passageEnd == null) {
    return null;
  }
  if (matchEnd <= matchStart) return null;
  if (matchStart < passageStart || matchEnd > passageEnd) return null;

  const start = matchStart - passageStart;
  const end = matchEnd - passageStart;
  if (end > passage.text.length) return null;
  return { start, end };
}

/**
 * Picks the highlight range for one (passage, match) pair.
 *
 * Real backend offsets win when present; they are exact by construction
 * (`input_text.slice(start, end) === input_sentence`) and so are never
 * `approximate`. Otherwise we fall back to locating the snippet by text
 * search, and only a total failure there is flagged `approximate` — which is
 * what makes the renderer draw a dashed rather than dotted underline.
 */
function resolveSpan(passage: DocPassage, match: MatchedSource): PassageSpan {
  const precise = offsetsWithinPassage(passage, match);
  if (precise) {
    return { matchId: match.id, start: precise.start, end: precise.end, approximate: false };
  }

  const located = locateSnippetInPassage(passage.text, match.userSnippet);
  if (located) {
    return { matchId: match.id, start: located.start, end: located.end, approximate: false };
  }

  return { matchId: match.id, start: 0, end: passage.text.length, approximate: true };
}

/**
 * Pairs each passage with the highlight ranges that belong to it.
 *
 * `visibleMatches` is already plan-filtered by the caller, so a passage whose
 * match is locked behind a paid tier simply renders with no highlight.
 */
export function buildRenderedPassages(
  passages: DocPassage[],
  visibleMatches: MatchedSource[],
): RenderedPassage[] {
  const byId = new Map(visibleMatches.map((m) => [m.id, m]));

  return passages.map((passage) => {
    const match = passage.matchId ? byId.get(passage.matchId) : undefined;
    if (!match) return { passage, spans: [] };

    return { passage, spans: [resolveSpan(passage, match)] };
  });
}

/** Splits passage text into alternating plain / highlighted chunks. */
export interface TextChunk {
  text: string;
  matchId: string | null;
  approximate: boolean;
}

export function chunkPassage(text: string, spans: PassageSpan[]): TextChunk[] {
  if (spans.length === 0) return [{ text, matchId: null, approximate: false }];

  const ordered = [...spans].sort((a, b) => a.start - b.start);
  const chunks: TextChunk[] = [];
  let cursor = 0;

  for (const span of ordered) {
    const start = Math.max(cursor, Math.min(span.start, text.length));
    const end = Math.max(start, Math.min(span.end, text.length));
    if (start > cursor) {
      chunks.push({ text: text.slice(cursor, start), matchId: null, approximate: false });
    }
    if (end > start) {
      chunks.push({ text: text.slice(start, end), matchId: span.matchId, approximate: span.approximate });
    }
    cursor = end;
  }

  if (cursor < text.length) {
    chunks.push({ text: text.slice(cursor), matchId: null, approximate: false });
  }
  return chunks;
}

/** Word count that behaves sensibly for Vietnamese and English alike. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}
