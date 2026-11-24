import type { DocPassage, MatchedSource, MatchSortMode } from "@etymos/shared";
import type { RenderedPassage } from "./highlights";

type CanonicalOrderKey = [
  tier: number,
  p1: number,
  p2: number,
  p3: number,
  negSimilarity: number,
  originalIndex: number,
];

function compareKeys(a: CanonicalOrderKey, b: CanonicalOrderKey): number {
  for (let k = 0; k < 6; k += 1) {
    if (a[k] !== b[k]) return a[k] - b[k];
  }
  return 0;
}

function minPdfRectPosition(match: MatchedSource): [number, number, number] | null {
  const rects = match.pdfRects;
  if (!rects || rects.length === 0) return null;
  let best: [number, number, number] | null = null;
  for (const r of rects) {
    if (!Number.isFinite(r.page) || !Number.isFinite(r.y0) || !Number.isFinite(r.x0)) continue;
    const candidate: [number, number, number] = [
      Math.trunc(r.page),
      Math.round(r.y0 * 10),
      Math.round(r.x0 * 10),
    ];
    if (
      !best ||
      candidate[0] < best[0] ||
      (candidate[0] === best[0] &&
        (candidate[1] < best[1] || (candidate[1] === best[1] && candidate[2] < best[2])))
    ) {
      best = candidate;
    }
  }
  return best;
}

function earlierSpan(
  a: { passageIndex: number; start: number; end: number },
  b: { passageIndex: number; start: number; end: number },
): boolean {
  if (a.passageIndex !== b.passageIndex) return a.passageIndex < b.passageIndex;
  if (a.start !== b.start) return a.start < b.start;
  return a.end < b.end;
}

/**
 * Orders matched sources in canonical top-to-bottom document reading order.
 *
 * Works both for freshly checked reports (that carry `startOffset` / `sortOrder`)
 * and previously saved historical reports from Supabase (which only have
 * `document_passages` and snippets/pdfRects):
 *   Tier 0: resolved span position inside rendered passages (reading-flow order)
 *   Tier 1: `match.startOffset` / `endOffset`
 *   Tier 2: top-most PDF bounding box (`pdfRects`: page, y0, x0)
 *   Tier 3: persisted `sortOrder`
 *   Tier 4: unlocated matches sorted deterministically by highest similarity
 */
export function orderMatchesByDocumentPosition(
  matches: MatchedSource[],
  rendered: RenderedPassage[],
): MatchedSource[] {
  if (matches.length <= 1) return matches;

  const firstPosByMatch = new Map<string, { passageIndex: number; start: number; end: number }>();

  for (let passageIndex = 0; passageIndex < rendered.length; passageIndex += 1) {
    const spans = rendered[passageIndex]?.spans ?? [];
    for (const span of spans) {
      const pos = { passageIndex, start: span.start, end: span.end };
      const existing = firstPosByMatch.get(span.matchId);
      if (!existing || earlierSpan(pos, existing)) {
        firstPosByMatch.set(span.matchId, pos);
      }
      for (const mergedId of span.mergedIds ?? []) {
        const prevMerged = firstPosByMatch.get(mergedId);
        if (!prevMerged || earlierSpan(pos, prevMerged)) {
          firstPosByMatch.set(mergedId, pos);
        }
      }
    }
  }

  // Fallback passage primary-match link in case a passage has matchId without spans.
  const passageIndexByPrimary = new Map<string, number>();
  for (let i = 0; i < rendered.length; i += 1) {
    const p: DocPassage | undefined = rendered[i]?.passage;
    if (p?.matchId && !passageIndexByPrimary.has(p.matchId)) {
      passageIndexByPrimary.set(p.matchId, i);
    }
  }

  const keyed = matches.map((match, originalIndex): { match: MatchedSource; key: CanonicalOrderKey } => {
    const negSim = -(Number.isFinite(match.matchPercent) ? match.matchPercent : 0);
    const renderedPos = firstPosByMatch.get(match.id);
    if (renderedPos) {
      return {
        match,
        key: [0, renderedPos.passageIndex, renderedPos.start, renderedPos.end, negSim, originalIndex],
      };
    }

    const primaryPassageIdx = passageIndexByPrimary.get(match.id);
    if (primaryPassageIdx != null) {
      return {
        match,
        key: [0, primaryPassageIdx, 0, 0, negSim, originalIndex],
      };
    }

    if (match.startOffset != null && Number.isFinite(match.startOffset)) {
      const start = match.startOffset;
      const end = match.endOffset != null && Number.isFinite(match.endOffset) ? match.endOffset : start;
      return {
        match,
        key: [1, start, end, 0, negSim, originalIndex],
      };
    }

    const pdfPos = minPdfRectPosition(match);
    if (pdfPos) {
      return {
        match,
        key: [2, pdfPos[0], pdfPos[1], pdfPos[2], negSim, originalIndex],
      };
    }

    if (match.sortOrder != null && Number.isFinite(match.sortOrder)) {
      return {
        match,
        key: [3, match.sortOrder, 0, 0, negSim, originalIndex],
      };
    }

    return {
      match,
      key: [4, 0, 0, 0, negSim, originalIndex],
    };
  });

  keyed.sort((a, b) => compareKeys(a.key, b.key));
  return keyed.map((entry) => entry.match);
}

/**
 * Reorders filtered canonical match indexes according to the user's selected sort mode
 * while preserving each entry's canonical index `i` (badge number `i + 1` and highlight color).
 */
export function sortMatchIndexes(
  indexes: number[],
  matches: MatchedSource[],
  mode: MatchSortMode,
): number[] {
  if (mode === "document") {
    return [...indexes].sort((a, b) => a - b);
  }
  return [...indexes].sort((a, b) => {
    const diff = (matches[b]?.matchPercent ?? 0) - (matches[a]?.matchPercent ?? 0);
    return diff !== 0 ? diff : a - b;
  });
}
