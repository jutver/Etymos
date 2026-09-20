import type { DocPassage } from "@etymos/shared";
import { cn } from "@etymos/shared";
import { chunkPassage, colorForIndex, LIGHT_HIGHLIGHT, type PassageSpan } from "./highlights";
import type { MatchColorIndex } from "./blocks";

/** Renders one passage's text as alternating plain / highlighted spans — the
 * same `<mark>` markup every text block type (paragraph, heading, list item)
 * shares. Extracted from the old monolithic DocumentBody so per-block
 * components (BlockItem.tsx) and table cells (TableBlock.tsx) can both use
 * it without duplicating the highlight-rendering logic. */
export function renderChunks(text: string, spans: PassageSpan[], colorIndexByMatch: MatchColorIndex) {
  return chunkPassage(text, spans).map((chunk, i) => {
    if (!chunk.matchId) return <span key={i}>{chunk.text}</span>;
    const colorIdx = colorIndexByMatch.get(chunk.matchId) ?? 0;
    const color = chunk.tone === "light" ? LIGHT_HIGHLIGHT : colorForIndex(colorIdx);
    return (
      <mark
        key={i}
        data-match-id={chunk.matchId}
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
        {chunk.text}
        <sup
          contentEditable={false}
          className="ml-0.5 select-none text-[0.625rem] font-bold tabular-nums opacity-70"
        >
          {colorIdx + 1}
        </sup>
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
) {
  const chunks = renderChunks(text, muted ? [] : spans, colorIndexByMatch);
  if (!muted) return chunks;
  return <span className="text-ink-300">{chunks}</span>;
}
