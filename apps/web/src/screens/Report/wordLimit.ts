import type { DocPassage } from "@etymos/shared";

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Walks `passages` in document order and returns the character offset (into
 * the concatenated document text) at which the running word count first
 * crosses `limit`. Used by the per-view "word limit" treatments to know
 * *where* to cut off, not just whether the document is over the limit.
 *
 * Prefers each passage's `startOffset`/`endOffset` (accurate, backend-supplied
 * character spans) when present; falls back to an accumulated
 * `text.length + 1` estimate (one separator char between passages) for
 * historical rows that predate offsets.
 *
 * Returns `Infinity` when the document never crosses `limit` (including the
 * empty-passages case).
 */
export function computeWordLimitOffset(passages: DocPassage[], limit: number): number {
  if (passages.length === 0) return Infinity;

  let runningWords = 0;
  let runningChar = 0;

  for (const passage of passages) {
    const text = passage.text ?? "";
    const hasOffsets = passage.startOffset !== undefined && passage.endOffset !== undefined;
    const spanStart = hasOffsets ? (passage.startOffset as number) : runningChar;
    const spanEnd = hasOffsets ? (passage.endOffset as number) : runningChar + text.length;

    const passageWords = wordCount(text);

    if (runningWords + passageWords <= limit) {
      runningWords += passageWords;
      runningChar = hasOffsets ? spanEnd : spanEnd + 1;
      continue;
    }

    // The limit is crossed somewhere inside this passage — find the
    // fractional position proportionally within its character span.
    const wordsNeeded = limit - runningWords;
    const fraction = passageWords > 0 ? wordsNeeded / passageWords : 0;
    const offset = spanStart + fraction * (spanEnd - spanStart);
    return Math.round(offset);
  }

  return Infinity;
}

