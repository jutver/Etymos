import type { ReactNode } from "react";
import type { InlineFormula, TextMark } from "@etymos/shared";
import { cn } from "@etymos/shared";
import { FormulaBlock, renderSafeKatex } from "./FormulaBlock";
import { chunkPassage, colorForIndex, LIGHT_HIGHLIGHT, type PassageSpan } from "./highlights";
import type { MatchColorIndex } from "./blocks";

export { FormulaBlock };

/** Renders one passage's text as alternating plain / highlighted spans — the
 * same `<mark>` markup every text block type (paragraph, heading, list item)
 * shares. Extracted from the old monolithic DocumentBody so per-block
 * components (BlockItem.tsx) and table cells (TableBlock.tsx) can both use
 * it without duplicating the highlight-rendering logic. */
/**
 * Splits `segment` (which starts at `base` in the passage text) at the
 * bold/italic mark and inline-formula boundaries and wraps the styled pieces
 * in `<strong>`/`<em>` or atomic non-editable KaTeX spans. Plain text comes
 * back as the bare string, so a passage without marks renders exactly as it did before.
 */
function renderMarked(
  segment: string,
  base: number,
  textMarks: TextMark[] | undefined,
  inlineFormulas?: InlineFormula[],
): ReactNode {
  if (!segment) return segment;
  const hasMarks = Boolean(textMarks && textMarks.length > 0);
  const hasFormulas = Boolean(inlineFormulas && inlineFormulas.length > 0);
  if (!hasMarks && !hasFormulas) return segment;

  const end = base + segment.length;
  const relevantMarks = hasMarks
    ? textMarks!.filter((m) => m.end > base && m.start < end)
    : [];
  const relevantFormulas = hasFormulas
    ? inlineFormulas!.filter((f) => f.start >= base && f.end <= end && f.end > f.start)
    : [];
  if (relevantMarks.length === 0 && relevantFormulas.length === 0) return segment;

  const insideFormula = (pos: number) =>
    relevantFormulas.some((f) => pos > f.start && pos < f.end);

  const cuts = new Set<number>([base, end]);
  for (const f of relevantFormulas) {
    cuts.add(f.start);
    cuts.add(f.end);
  }
  for (const m of relevantMarks) {
    const ms = Math.max(base, m.start);
    const me = Math.min(end, m.end);
    if (!insideFormula(ms)) cuts.add(ms);
    if (!insideFormula(me)) cuts.add(me);
  }
  const points = [...cuts].sort((a, b) => a - b);

  const nodes: ReactNode[] = [];
  for (let k = 0; k < points.length - 1; k++) {
    const from = points[k];
    const to = points[k + 1];
    if (to <= from) continue;

    const formula = relevantFormulas.find((f) => f.start === from && f.end === to);
    if (formula) {
      const katexHtml = renderSafeKatex(formula.latex, false);
      if (katexHtml) {
        nodes.push(
          <span
            key={`f${from}`}
            contentEditable={false}
            data-inline-formula={formula.latex}
            className="inline-formula"
            dangerouslySetInnerHTML={{ __html: katexHtml }}
          />,
        );
        continue;
      }
    }

    const piece = segment.slice(from - base, to - base);
    const bold = relevantMarks.some((m) => m.style === "bold" && m.start <= from && m.end >= to);
    const italic = relevantMarks.some((m) => m.style === "italic" && m.start <= from && m.end >= to);
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
  inlineFormulas?: InlineFormula[],
) {
  let offset = 0;
  return chunkPassage(text, spans).map((chunk, i) => {
    const chunkStart = offset;
    offset += chunk.text.length;
    const content = renderMarked(chunk.text, chunkStart, textMarks, inlineFormulas);
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

import { isOverLimit } from "./wordLimit";
export { isOverLimit };

/** Renders passage text, muting it (and dropping its highlight spans/score
 * badge) once the passage has crossed the word-limit boundary. */
export function renderPassageText(
  text: string,
  spans: PassageSpan[],
  colorIndexByMatch: MatchColorIndex,
  muted: boolean,
  textMarks?: TextMark[],
  inlineFormulas?: InlineFormula[],
) {
  const chunks = renderChunks(text, muted ? [] : spans, colorIndexByMatch, textMarks, inlineFormulas);
  if (!muted) return chunks;
  return <span className="text-ink-300">{chunks}</span>;
}
