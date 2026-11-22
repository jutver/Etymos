import { describe, expect, it } from "vitest";
import {
  clampPdfRect,
  dedupeOverlappingPdfOverlays,
  mergeAdjacentPdfRects,
  parsePdfRects,
  pdfRectPages,
  pdfRectsOnPage,
} from "./pdfRects";

describe("pdfRects helpers", () => {
  it("validates well-formed backend pdf_rects and rejects malformed boxes", () => {
    expect(parsePdfRects([{ page: 1, x0: 72, y0: 100, x1: 280, y1: 114 }])).toEqual([
      { page: 1, x0: 72, y0: 100, x1: 280, y1: 114 },
    ]);
    expect(parsePdfRects([{ page: 0, x0: 72, y0: 100, x1: 280, y1: 114 }])).toBeUndefined();
    expect(parsePdfRects([{ page: 1, x0: 280, y0: 100, x1: 72, y1: 114 }])).toBeUndefined();
    expect(parsePdfRects([])).toBeUndefined();
  });

  it("clamps coordinates to page bounds and drops degenerate fragments", () => {
    expect(clampPdfRect({ page: 1, x0: -10, y0: -5, x1: 610, y1: 860 }, { width: 595, height: 842 })).toEqual({
      page: 1,
      x0: 0,
      y0: 0,
      x1: 595,
      y1: 842,
    });
    expect(clampPdfRect({ page: 1, x0: 600, y0: 10, x1: 620, y1: 25 }, { width: 595, height: 842 })).toBeNull();
  });

  it("merges adjacent collinear rects and scales linearly across zoom changes", () => {
    const rects = [
      { page: 1, x0: 72, y0: 200, x1: 140, y1: 212 },
      { page: 1, x0: 142, y0: 200, x1: 240, y1: 212 },
      { page: 2, x0: 72, y0: 300, x1: 220, y1: 312 },
    ];
    expect(mergeAdjacentPdfRects(rects)).toEqual([
      { page: 1, x0: 72, y0: 200, x1: 240, y1: 212 },
      { page: 2, x0: 72, y0: 300, x1: 220, y1: 312 },
    ]);
    expect(pdfRectPages(rects)).toEqual([1, 2]);
    expect(pdfRectsOnPage(rects, 1, 0.5, { width: 595, height: 842 })).toEqual([
      { x: 36, y: 100, width: 84, height: 6 },
    ]);
    expect(pdfRectsOnPage(rects, 1, 2.0, { width: 595, height: 842 })).toEqual([
      { x: 144, y: 400, width: 336, height: 24 },
    ]);
  });

  it("deduplicates > 50% overlapping multi-source overlays while preferring active and higher-priority matches", () => {
    const boxes = [
      { matchId: "low", x: 10, y: 20, width: 100, height: 14, priority: 10 },
      { matchId: "high", x: 10, y: 20, width: 100, height: 14, priority: 1098 },
      { matchId: "other", x: 10, y: 50, width: 90, height: 14, priority: 900 },
    ];
    expect(dedupeOverlappingPdfOverlays(boxes).map((b) => b.matchId)).toEqual(["high", "other"]);
    // When `low` is explicitly focused by the user, keep it visible on top instead of suppressing it.
    expect(dedupeOverlappingPdfOverlays(boxes, "low").map((b) => b.matchId)).toEqual(["low", "other"]);
  });
});
