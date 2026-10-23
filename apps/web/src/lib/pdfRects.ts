import type { PdfRect } from "@etymos/shared";

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

/** The boxes on one page in pixels at `scale` (pdf.js lays a page out at
 * PDF points times the zoom, from the same top-left corner). */
export function pdfRectsOnPage(rects: PdfRect[], page: number, scale: number) {
  return rects
    .filter((r) => r.page === page)
    .map((r) => ({ x: r.x0 * scale, y: r.y0 * scale, width: (r.x1 - r.x0) * scale, height: (r.y1 - r.y0) * scale }));
}

/** Pages the boxes are on, in order. */
export function pdfRectPages(rects: PdfRect[]): number[] {
  return [...new Set(rects.map((r) => r.page))].sort((a, b) => a - b);
}
