import type { PdfRect } from "@etymos/shared";

export interface PageBounds {
  width: number;
  height: number;
}

/** `pdf_rects` from the backend or a `document_matches` row, kept only when
 * every box is well formed - a malformed one falls back to text search. */
export function parsePdfRects(value: unknown): PdfRect[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const rects: PdfRect[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const r = item as Record<string, unknown>;
    const [page, x0, y0, x1, y1] = [r.page, r.x0, r.y0, r.x1, r.y1].map(Number);
    if (![page, x0, y0, x1, y1].every(Number.isFinite) || page < 1 || x1 <= x0 || y1 <= y0) return undefined;
    rects.push({ page, x0, y0, x1, y1 });
  }
  return rects;
}

/** Clamp a PDF box to non-negative coordinates (and explicit page bounds if
 * known), dropping degenerate boxes narrower/shorter than 0.5 PDF points. */
export function clampPdfRect(rect: PdfRect, bounds?: PageBounds): PdfRect | null {
  const maxW = bounds && Number.isFinite(bounds.width) && bounds.width > 0 ? bounds.width : Infinity;
  const maxH = bounds && Number.isFinite(bounds.height) && bounds.height > 0 ? bounds.height : Infinity;
  const x0 = Math.max(0, Math.min(rect.x0, maxW));
  const x1 = Math.max(0, Math.min(rect.x1, maxW));
  const y0 = Math.max(0, Math.min(rect.y0, maxH));
  const y1 = Math.max(0, Math.min(rect.y1, maxH));
  if (x1 - x0 < 0.5 || y1 - y0 < 0.5) return null;
  return { page: rect.page, x0, y0, x1, y1 };
}

/** Merge touching/adjacent collinear rects on the same page for one match so
 * line highlights render cleanly without micro-seams. */
export function mergeAdjacentPdfRects(rects: PdfRect[]): PdfRect[] {
  if (rects.length <= 1) return rects;
  const byPage = new Map<number, PdfRect[]>();
  for (const r of rects) {
    const list = byPage.get(r.page);
    if (list) list.push(r);
    else byPage.set(r.page, [r]);
  }

  const out: PdfRect[] = [];
  for (const [page, pageRects] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = [...pageRects].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    const merged: PdfRect[] = [];
    for (const r of sorted) {
      const last = merged[merged.length - 1];
      if (last) {
        const minH = Math.min(last.y1 - last.y0, r.y1 - r.y0);
        const vOverlap = Math.min(last.y1, r.y1) - Math.max(last.y0, r.y0);
        const sameRow = minH > 0 && vOverlap >= 0.6 * minH;
        const hGap = r.x0 - last.x1;
        if (sameRow && hGap <= 4 && r.x0 >= last.x0 - 2) {
          merged[merged.length - 1] = {
            page,
            x0: Math.min(last.x0, r.x0),
            y0: Math.min(last.y0, r.y0),
            x1: Math.max(last.x1, r.x1),
            y1: Math.max(last.y1, r.y1),
          };
          continue;
        }
      }
      merged.push(r);
    }
    out.push(...merged);
  }
  return out;
}

/** The boxes on one page in pixels at `scale` (pdf.js lays a page out at
 * PDF points times the zoom, from the same top-left corner), clamped to
 * optional page bounds and cleanly merged along each visual line. */
export function pdfRectsOnPage(rects: PdfRect[], page: number, scale: number, bounds?: PageBounds) {
  const pageRects: PdfRect[] = [];
  for (const r of rects) {
    if (r.page !== page) continue;
    const clamped = clampPdfRect(r, bounds);
    if (clamped) pageRects.push(clamped);
  }
  return mergeAdjacentPdfRects(pageRects).map((r) => ({
    x: r.x0 * scale,
    y: r.y0 * scale,
    width: (r.x1 - r.x0) * scale,
    height: (r.y1 - r.y0) * scale,
  }));
}

/** Deduplicate heavily overlapping (> 50% area) highlight boxes across
 * DIFFERENT sources so translucent fills stay airy instead of compounding.
 * Prefers `activeMatchId`, then higher priority. */
export function dedupeOverlappingPdfOverlays<
  T extends { matchId: string; x: number; y: number; width: number; height: number; priority: number },
>(rects: T[], activeMatchId?: string | null): T[] {
  if (rects.length <= 1) return rects;
  const sorted = [...rects].sort((a, b) => {
    const aActive = activeMatchId && a.matchId === activeMatchId ? 1 : 0;
    const bActive = activeMatchId && b.matchId === activeMatchId ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    return b.priority - a.priority;
  });

  const kept: T[] = [];
  for (const r of sorted) {
    const rArea = r.width * r.height || 1;
    const isActive = activeMatchId && r.matchId === activeMatchId;
    const shadowedByOther =
      !isActive &&
      kept.some((k) => {
        if (k.matchId === r.matchId) return false;
        const ix = Math.max(0, Math.min(r.x + r.width, k.x + k.width) - Math.max(r.x, k.x));
        const iy = Math.max(0, Math.min(r.y + r.height, k.y + k.height) - Math.max(r.y, k.y));
        return (ix * iy) / rArea > 0.5;
      });
    if (!shadowedByOther) kept.push(r);
  }
  return kept;
}

/** Pages the boxes are on, in order. */
export function pdfRectPages(rects: PdfRect[]): number[] {
  return [...new Set(rects.map((r) => r.page))].sort((a, b) => a - b);
}
