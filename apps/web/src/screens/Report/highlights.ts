import type { DocPassage, MatchedSource } from "@etymos/shared";
import { tr } from "../../lib/i18n";

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
    label: tr("Amber"),
    mark: "bg-[#fdf0c9] text-[#5a4408] decoration-[#b45309] dark:bg-[#5a4408] dark:text-[#fdf0c9] dark:decoration-[#fbbf24]",
    chip: "bg-[#eab308]",
  },
  {
    key: "rose",
    label: tr("Rose"),
    mark: "bg-[#fde0e4] text-[#7f1d3a] decoration-[#be123c] dark:bg-[#5c1024] dark:text-[#fde0e4] dark:decoration-[#fb7185]",
    chip: "bg-[#e11d48]",
  },
  {
    key: "violet",
    label: tr("Violet"),
    mark: "bg-[#e9e2fd] text-[#4c1d95] decoration-[#7c3aed] dark:bg-[#3b1e75] dark:text-[#e9e2fd] dark:decoration-[#a78bfa]",
    chip: "bg-[#7c3aed]",
  },
  {
    key: "teal",
    label: tr("Teal"),
    mark: "bg-[#cdf3ea] text-[#0f4f45] decoration-[#0d9488] dark:bg-[#0c3b34] dark:text-[#cdf3ea] dark:decoration-[#2dd4bf]",
    chip: "bg-[#0d9488]",
  },
  {
    key: "sky",
    label: tr("Sky"),
    mark: "bg-[#d9e8fe] text-[#1e3a8a] decoration-[#2563eb] dark:bg-[#10315e] dark:text-[#d9e8fe] dark:decoration-[#60a5fa]",
    chip: "bg-[#2563eb]",
  },
  {
    key: "lime",
    label: tr("Lime"),
    mark: "bg-[#e6f5c8] text-[#3f5c0c] decoration-[#65a30d] dark:bg-[#2f4110] dark:text-[#e6f5c8] dark:decoration-[#a3e635]",
    chip: "bg-[#65a30d]",
  },
];

export function colorForIndex(index: number): HighlightColor {
  return HIGHLIGHT_COLORS[index % HIGHLIGHT_COLORS.length];
}

/**
 * How strongly a match is flagged. "heavy" matches keep the rotating identity
 * palette above; "light" ones (high similarity, but short of a near-verbatim
 * copy) share a single pale pink so they read as secondary.
 */
export type MatchTone = "heavy" | "light";

/**
 * Similarity (`matchPercent`, 0-100) at which a match counts as heavy. Below
 * this the sentence is still clearly similar — the backend only reports
 * sentences from ~0.87 up — but reads as a close paraphrase rather than a
 * near-verbatim copy. Driven by `matchPercent` (not the backend label) because
 * that is what Supabase persists, so reports restored from history tint the
 * same way as freshly-run ones.
 */
export const HEAVY_MATCH_PERCENT = 95;

export function matchTone(match: Pick<MatchedSource, "matchPercent">): MatchTone {
  return match.matchPercent >= HEAVY_MATCH_PERCENT ? "heavy" : "light";
}

export const LIGHT_HIGHLIGHT: HighlightColor = {
  key: "blush",
  label: tr("Light pink"),
  mark: "bg-[#fdeef2] text-[#7f1d3a] decoration-[#f4a9bd] dark:bg-[#4a1826] dark:text-[#fde0e4] dark:decoration-[#fb9db4]",
  chip: "bg-[#f4a9bd]",
};

/** Colour for a match's highlight and its sidebar swatch (they must agree). */
export function colorForMatch(match: Pick<MatchedSource, "matchPercent">, index: number): HighlightColor {
  return matchTone(match) === "light" ? LIGHT_HIGHLIGHT : colorForIndex(index);
}

/** One resolved highlight range inside a single passage's text. */
export interface PassageSpan {
  matchId: string;
  tone: MatchTone;
  /** Other matches that cover the same words but lost to this one, so they
   *  have no highlight of their own. Kept so selecting one of their sidebar
   *  cards can still jump to (and emphasise) this span. */
  mergedIds?: string[];
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
  const tone = matchTone(match);
  const precise = offsetsWithinPassage(passage, match);
  if (precise) {
    return { matchId: match.id, tone, start: precise.start, end: precise.end, approximate: false };
  }

  const located = locateSnippetInPassage(passage.text, match.userSnippet);
  if (located) {
    return { matchId: match.id, tone, start: located.start, end: located.end, approximate: false };
  }

  return { matchId: match.id, tone, start: 0, end: passage.text.length, approximate: true };
}

/** Exact, then whitespace-insensitive, snippet search — no anchor/whole-passage
 * fallback, because a wrong guess for a *secondary* match would highlight text
 * that isn't actually matched. */
function locateSnippetLoose(passageText: string, snippet: string): { start: number; end: number } | null {
  const trimmed = snippet.trim();
  if (!trimmed) return null;

  const exact = passageText.indexOf(trimmed);
  if (exact !== -1) return { start: exact, end: exact + trimmed.length };

  const loose = whitespaceInsensitivePattern(trimmed);
  const hit = loose?.exec(passageText);
  return hit ? { start: hit.index, end: hit.index + hit[0].length } : null;
}

/**
 * Range of `match` inside `passage`, for matches beyond the passage's primary
 * one. Returns null when the match doesn't belong to this passage.
 *
 * Backend offsets are trusted only if they still slice out the snippet (a
 * passage whose text was trimmed would shift them); otherwise the snippet is
 * re-anchored by text search. Matches that have offsets but sit outside this
 * passage are skipped outright rather than text-searched, so a sentence quoted
 * twice in the document can't light up in the wrong place.
 */
function locateSecondarySpan(passage: DocPassage, match: MatchedSource): PassageSpan | null {
  const tone = matchTone(match);
  const hasOffsets =
    match.startOffset != null &&
    match.endOffset != null &&
    passage.startOffset != null &&
    passage.endOffset != null;

  if (hasOffsets) {
    const precise = offsetsWithinPassage(passage, match);
    if (!precise) return null;
    if (passage.text.slice(precise.start, precise.end).trim() === match.userSnippet.trim()) {
      return { matchId: match.id, tone, start: precise.start, end: precise.end, approximate: false };
    }
    const reanchored = locateSnippetLoose(passage.text, match.userSnippet);
    return reanchored ? { matchId: match.id, tone, ...reanchored, approximate: false } : null;
  }

  const located = locateSnippetLoose(passage.text, match.userSnippet);
  return located ? { matchId: match.id, tone, ...located, approximate: false } : null;
}

interface SpanCandidate {
  span: PassageSpan;
  percent: number;
  primary: boolean;
}

/** Higher wins when two candidates overlap: an exactly-located span beats a
 * whole-passage guess, a heavy match beats a light one, then the passage's own
 * primary match, then the higher similarity. */
function candidateRank({ span, primary }: SpanCandidate): number {
  return (span.approximate ? 0 : 4) + (span.tone === "heavy" ? 2 : 0) + (primary ? 1 : 0);
}

function pickNonOverlapping(candidates: SpanCandidate[]): PassageSpan[] {
  const ordered = [...candidates].sort(
    (a, b) => candidateRank(b) - candidateRank(a) || b.percent - a.percent || a.span.start - b.span.start,
  );

  const accepted: PassageSpan[] = [];
  for (const { span } of ordered) {
    if (span.end <= span.start) continue;
    const covering = accepted.find((kept) => span.start < kept.end && kept.start < span.end);
    if (covering) {
      // Not drawn — but it points at the same words, so remember it.
      (covering.mergedIds ??= []).push(span.matchId);
      continue;
    }
    accepted.push(span);
  }
  return accepted.sort((a, b) => a.start - b.start);
}

/**
 * Which highlighted match each match should focus in the document.
 *
 * A match with its own highlight maps to itself; one that was merged into a
 * stronger overlapping highlight maps to that highlight. A match absent from
 * the result has nowhere to point (couldn't be located, or sits past the word
 * limit), which callers use to tell the user instead of silently doing nothing.
 */
export function buildMatchFocusMap(rendered: RenderedPassage[]): Map<string, string> {
  const focus = new Map<string, string>();
  for (const { spans } of rendered) {
    for (const span of spans) focus.set(span.matchId, span.matchId);
  }
  for (const { spans } of rendered) {
    for (const span of spans) {
      for (const id of span.mergedIds ?? []) {
        if (!focus.has(id)) focus.set(id, span.matchId);
      }
    }
  }
  return focus;
}

/**
 * Pairs each passage with the highlight ranges that belong to it.
 *
 * A passage can carry many matched sentences (a whole paragraph is one
 * passage), so every visible match that lands inside it gets a span — not just
 * the one `passage.matchId` points at. Overlapping matches on the same words
 * collapse to the strongest one (see `candidateRank`).
 *
 * `visibleMatches` is already plan-filtered by the caller, so a match locked
 * behind a paid tier simply renders with no highlight.
 */
export function buildRenderedPassages(
  passages: DocPassage[],
  visibleMatches: MatchedSource[],
): RenderedPassage[] {
  const byId = new Map(visibleMatches.map((m) => [m.id, m]));

  return passages.map((passage) => {
    const primary = passage.matchId ? byId.get(passage.matchId) : undefined;
    const candidates: SpanCandidate[] = [];

    if (primary) {
      candidates.push({ span: resolveSpan(passage, primary), percent: primary.matchPercent, primary: true });
    }

    if (passage.text) {
      for (const match of visibleMatches) {
        if (match === primary) continue;
        const span = locateSecondarySpan(passage, match);
        if (span) candidates.push({ span, percent: match.matchPercent, primary: false });
      }
    }

    return { passage, spans: pickNonOverlapping(candidates) };
  });
}

/** Splits passage text into alternating plain / highlighted chunks. */
export interface TextChunk {
  text: string;
  matchId: string | null;
  approximate: boolean;
  /** Only meaningful when `matchId` is set. */
  tone: MatchTone;
}

export function chunkPassage(text: string, spans: PassageSpan[]): TextChunk[] {
  if (spans.length === 0) return [{ text, matchId: null, approximate: false, tone: "heavy" }];

  const ordered = [...spans].sort((a, b) => a.start - b.start);
  const chunks: TextChunk[] = [];
  let cursor = 0;

  for (const span of ordered) {
    const start = Math.max(cursor, Math.min(span.start, text.length));
    const end = Math.max(start, Math.min(span.end, text.length));
    if (start > cursor) {
      chunks.push({ text: text.slice(cursor, start), matchId: null, approximate: false, tone: "heavy" });
    }
    if (end > start) {
      chunks.push({
        text: text.slice(start, end),
        matchId: span.matchId,
        approximate: span.approximate,
        tone: span.tone,
      });
    }
    cursor = end;
  }

  if (cursor < text.length) {
    chunks.push({ text: text.slice(cursor), matchId: null, approximate: false, tone: "heavy" });
  }
  return chunks;
}

/** Word count that behaves sensibly for Vietnamese and English alike. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

// ---------------------------------------------------------------------------
// AI-DETECTION HIGHLIGHTING (AiDetectionSection <-> Document/Original views)
// ---------------------------------------------------------------------------
// The detector scores whole paragraphs, not sentences (see backend/
// ai_detector.py's `select_segments`), so — unlike plagiarism matches, which
// splice a highlight around one sentence inside a passage — an AI-flagged
// segment always highlights an *entire* passage/block. That is the correct
// granularity here, not a simplification of the match machinery above.

/** One AI-detection segment's flagged range, in the report's `input_text`
 * coordinate space — the same coordinates `MatchedSource.startOffset` /
 * `DocPassage.startOffset` use, per ai_detector.py's docstring, so a segment
 * can be located against passages the same way `offsetsWithinPassage` does
 * for matches. */
export interface AiSegmentRange {
  id: string;
  start: number;
  end: number;
  /** First words of the paragraph (backend `_excerpt`, may end in "…").
   * Used when passages carry no offsets — see mapAiSegmentsToPassages. */
  excerpt?: string;
}

/**
 * Maps each AI segment to the passage it falls inside (paragraph-for-
 * paragraph, since `select_segments` derives both from the same backend
 * blocks). A segment with no match — no offsets on either side, or an old
 * report with no passage structure — is simply absent from the result, the
 * same "can't be located" outcome an unlocatable plagiarism match gets.
 */
export function mapAiSegmentsToPassages(
  passages: DocPassage[],
  segments: AiSegmentRange[],
): Map<string, string> {
  const bySegment = new Map<string, string>();
  for (const seg of segments) {
    const hit = passages.find(
      (p) =>
        p.startOffset != null &&
        p.endOffset != null &&
        seg.start >= p.startOffset &&
        seg.end <= p.endOffset,
    );
    if (hit) {
      bySegment.set(seg.id, hit.id);
      continue;
    }
    // A report reopened from Supabase has no passage offsets
    // (document_passages doesn't store them), so the offset test above
    // never hits: find the paragraph by its opening words instead.
    const byText = passageForExcerpt(passages, seg.excerpt);
    if (byText) bySegment.set(seg.id, byText.id);
  }
  return bySegment;
}

// Same folding as the backend's ai_detector.normalize_text (which built
// the excerpt): NFKC ligatures, "detec- tion" re-joined, whitespace squashed.
function squashWhitespace(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/([\p{L}\p{N}_])-\s+(?=\p{Ll})/gu, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function passageForExcerpt(passages: DocPassage[], excerpt: string | undefined): DocPassage | undefined {
  const needle = squashWhitespace((excerpt ?? "").replace(/…$/, ""));
  // Too short to tell paragraphs apart reliably.
  if (needle.length < 20) return undefined;
  return passages.find((p) => p.blockType !== "heading" && squashWhitespace(p.text ?? "").includes(needle));
}

/** Passage ids that should get the "looks machine-written" paragraph-level
 * treatment in the Document view — just the value set of `mapAiSegmentsToPassages`,
 * named separately because that's what BlockItem actually consumes. */
export function aiFlaggedPassageIds(bySegment: Map<string, string>): Set<string> {
  return new Set(bySegment.values());
}
