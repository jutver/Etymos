import { describe, expect, it } from "vitest";
import { parsePdfRects, pdfRectPages, pdfRectsOnPage } from "./pdfRects";

describe("pdf rects", () => {
  it("parses well-formed boxes", () => {
    expect(parsePdfRects([{ page: 3, x0: 85, y0: 120.6, x1: 510.2, y1: 131.6 }])).toEqual([
      { page: 3, x0: 85, y0: 120.6, x1: 510.2, y1: 131.6 },
    ]);
  });

  it("drops the whole set when one box is malformed", () => {
    expect(parsePdfRects([{ page: 1, x0: 1, y0: 1, x1: 2, y1: 2 }, { page: 1, x0: 5, y0: 1, x1: 2, y1: 2 }])).toBeUndefined();
    expect(parsePdfRects([{ page: 0, x0: 1, y0: 1, x1: 2, y1: 2 }])).toBeUndefined();
    expect(parsePdfRects(null)).toBeUndefined();
    expect(parsePdfRects([])).toBeUndefined();
  });

  it("scales the boxes of one page to pixels", () => {
    const rects = [
      { page: 2, x0: 100, y0: 50, x1: 300, y1: 60 },
      { page: 3, x0: 10, y0: 10, x1: 20, y1: 20 },
    ];
    expect(pdfRectsOnPage(rects, 2, 1.5)).toEqual([{ x: 150, y: 75, width: 300, height: 15 }]);
    expect(pdfRectPages(rects)).toEqual([2, 3]);
  });
});
