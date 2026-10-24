import type { ReactNode } from "react";
import type { DocPassage, TextMark } from "@etymos/shared";
import { cn } from "@etymos/shared";
import { chunkPassage, colorForIndex, LIGHT_HIGHLIGHT, type PassageSpan } from "./highlights";
import type { MatchColorIndex } from "./blocks";

/** Renders one passage's text as alternating plain / highlighted spans — the
 * same `<mark>` markup every text block type (paragraph, heading, list item)
 * shares. Extracted from the old monolithic DocumentBody so per-block
 * components (BlockItem.tsx) and table cells (TableBlock.tsx) can both use
 * it without duplicating the highlight-rendering logic. */
/**
 * Splits `segment` (which starts at `base` in the passage text) at the
 * bold/italic mark boundaries and wraps the styled pieces in
 * <strong>/<em>. Plain text comes back as the bare string, so a passage
 * without marks renders exactly as it did before.
 */
function renderMarked(segment: string, base: number, textMarks: TextMark[] | undefined): ReactNode {
  if (!textMarks || textMarks.length === 0 || !segment) return segment;
  const end = base + segment.length;
  const relevant = textMarks.filter((m) => m.end > base && m.start < end);
  if (relevant.length === 0) return segment;

  const cuts = new Set<number>([base, end]);
  for (const m of relevant) {
    cuts.add(Math.max(base, m.start));
    cuts.add(Math.min(end, m.end));
  }
  const points = [...cuts].sort((a, b) => a - b);

  const nodes: ReactNode[] = [];
  for (let k = 0; k < points.length - 1; k++) {
    const from = points[k];
    const to = points[k + 1];
    if (to <= from) continue;
    const piece = segment.slice(from - base, to - base);
    const bold = relevant.some((m) => m.style === "bold" && m.start <= from && m.end >= to);
    const italic = relevant.some((m) => m.style === "italic" && m.start <= from && m.end >= to);
    let node: ReactNode = piece;
    if (italic) node = <em key={`i${from}`}>{node}</em>;
    if (bold) node = <strong key={`b${from}`}>{node}</strong>;
    nodes.push(bold || italic ? node : <span key={`t${from}`}>{piece}</span>);
  }
  return nodes;
}

export function renderChunks(
  text: string,
  spans: PassageSpan[],
  colorIndexByMatch: MatchColorIndex,
  textMarks?: TextMark[],
) {
  let offset = 0;
  return chunkPassage(text, spans).map((chunk, i) => {
    const chunkStart = offset;
    offset += chunk.text.length;
    const content = renderMarked(chunk.text, chunkStart, textMarks);
    if (!chunk.matchId) return <span key={i}>{content}</span>;
    const colorIdx = colorIndexByMatch.get(chunk.matchId) ?? 0;
    const color = chunk.tone === "light" ? LIGHT_HIGHLIGHT : colorForIndex(colorIdx);
    return (
      <mark
        key={i}
        data-match-id={chunk.matchId}
        // The source number is drawn by CSS from this attribute (globals.css),
        // not as a child element: the editor's text is read back with
        // innerText, and a real <sup>41</sup> ended up saved into the
        // document as "…results.41".
        data-badge={colorIdx + 1}
        // Non-colour signal #1: every highlight is underlined, so it survives
        // greyscale and colour-blind viewing. Dotted means we know the exact
        // span; dashed means we could only approximate it. Mutually
        // exclusive — see the note this mirrors in the old DocumentCanvas.
        className={cn(
          "cursor-pointer rounded-[3px] px-[1px] underline decoration-2 underline-offset-[3px] transition-shadow",
          chunk.approximate ? "decoration-dashed" : "decoration-dotted",
          color.mark,
        )}
      >
        {content}
      </mark>
    );
  });
}

/**
 * A passage is "over the limit" once its own start sits at/past the
 * document-wide boundary offset. Blocks with no backing passage (freshly
 * inserted by the user) are never muted.
 */
export function isOverLimit(passage: DocPassage | undefined, overLimitOffset: number | undefined): boolean {
  if (!passage || overLimitOffset == null || passage.startOffset == null) return false;
  return passage.startOffset >= overLimitOffset;
}

/** Renders passage text, muting it (and dropping its highlight spans/score
 * badge) once the passage has crossed the word-limit boundary. */
export function renderPassageText(
  text: string,
  spans: PassageSpan[],
  colorIndexByMatch: MatchColorIndex,
  muted: boolean,
  textMarks?: TextMark[],
) {
  const chunks = renderChunks(text, muted ? [] : spans, colorIndexByMatch, textMarks);
  if (!muted) return chunks;
  return <span className="text-ink-300">{chunks}</span>;
}
