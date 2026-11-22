export const MAX_EFFECTIVE_SCALE = 2.25;
export const MAX_CANVAS_PIXELS = 3_600_000;

/**
 * Cap the effective pixel ratio for a PDF canvas so high-zoom pages never
 * blow past GPU backing-store limits (~14.4 MB RGBA per canvas vs. ~90+ MB).
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
 * Strict sliding window of mounted PDF pages: only pages currently intersecting
 * the scroll viewport plus `[currentPage - bufferRadius .. currentPage + bufferRadius]`.
 */
export function computeMountedPagesWindow(
  currentPage: number,
  numPages: number,
  intersecting: ReadonlySet<number>,
  bufferRadius = 1,
): Set<number> {
  const next = new Set<number>();
  if (numPages <= 0) return next;
  const clampedCur = Math.min(Math.max(1, currentPage), numPages);
  for (const p of intersecting) {
    if (p >= 1 && p <= numPages) next.add(p);
  }
  const minBuf = Math.max(1, clampedCur - bufferRadius);
  const maxBuf = Math.min(numPages, clampedCur + bufferRadius);
  for (let p = minBuf; p <= maxBuf; p++) next.add(p);
  return next;
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
