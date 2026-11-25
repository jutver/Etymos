export const MAX_EFFECTIVE_SCALE = 2.0;
export const MAX_CANVAS_PIXELS = 2_200_000;

/**
 * Cap the effective pixel ratio for a PDF canvas so high-zoom pages never
 * blow past GPU backing-store limits (~8.8 MB RGBA per canvas vs. ~90+ MB).
 */
export function computeCanvasDpr(
  pageWidth: number,
  pageHeight: number,
  scale: number,
  devicePixelRatio: number,
): number {
  const safeScale = Math.max(0.1, scale);
  const baseArea = Math.max(1, pageWidth * pageHeight);
  const maxDpr = Math.min(2, devicePixelRatio || 1);
  const byPixels = Math.sqrt(MAX_CANVAS_PIXELS / (baseArea * safeScale * safeScale));
  const byEffectiveScale = MAX_EFFECTIVE_SCALE / safeScale;
  return Math.max(0.75, Math.min(maxDpr, byPixels, byEffectiveScale));
}

/**
 * Strict sliding window of mounted PDF pages: prioritizes `currentPage` +
 * intersecting viewport pages + `[currentPage - bufferRadius .. currentPage + bufferRadius]`,
 * capped at `maxMountedPages` so zooming out on multi-page PDFs never mounts dozens of canvases.
 */
export function computeMountedPagesWindow(
  currentPage: number,
  numPages: number,
  intersecting: ReadonlySet<number>,
  bufferRadius = 1,
  maxMountedPages = 4,
): Set<number> {
  if (numPages <= 0 || maxMountedPages <= 0) return new Set();
  const candidates = new Set<number>();
  const clampedCur = Math.min(Math.max(1, currentPage), numPages);
  for (const p of intersecting) {
    if (p >= 1 && p <= numPages) candidates.add(p);
  }
  const minBuf = Math.max(1, clampedCur - bufferRadius);
  const maxBuf = Math.min(numPages, clampedCur + bufferRadius);
  for (let p = minBuf; p <= maxBuf; p++) candidates.add(p);

  if (candidates.size <= maxMountedPages) return candidates;

  const sorted = Array.from(candidates).sort((a, b) => {
    if (a === clampedCur) return -1;
    if (b === clampedCur) return 1;
    const distDiff = Math.abs(a - clampedCur) - Math.abs(b - clampedCur);
    return distDiff !== 0 ? distDiff : a - b;
  });
  return new Set(sorted.slice(0, maxMountedPages));
}

export function diffEvictedPages(prev: ReadonlySet<number>, next: ReadonlySet<number>): number[] {
  const evicted: number[] = [];
  for (const p of prev) {
    if (!next.has(p)) evicted.push(p);
  }
  return evicted;
}

export function sameNumberSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}
