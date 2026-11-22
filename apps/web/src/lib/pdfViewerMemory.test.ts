import { describe, expect, it } from "vitest";
import {
  MAX_CANVAS_PIXELS,
  MAX_EFFECTIVE_SCALE,
  computeCanvasDpr,
  computeMountedPagesWindow,
  diffEvictedPages,
  sameNumberSet,
} from "./pdfViewerMemory";

describe("pdfViewerMemory", () => {
  describe("computeCanvasDpr", () => {
    it("preserves crisp 2x DPR at 100% scale on Letter/A4 pages", () => {
      const dpr = computeCanvasDpr(595, 842, 1, 2);
      expect(dpr).toBe(2);
      expect(595 * 1 * dpr * 842 * 1 * dpr).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
    });

    it("caps DPR by effective scale and pixel budget at high zoom", () => {
      const dpr15 = computeCanvasDpr(595, 842, 1.5, 2);
      expect(1.5 * dpr15).toBeLessThanOrEqual(MAX_EFFECTIVE_SCALE + 1e-6);

      const dpr30 = computeCanvasDpr(595, 842, 3, 2);
      expect(dpr30).toBe(0.75);
      expect(595 * 3 * dpr30 * 842 * 3 * dpr30).toBeLessThanOrEqual(MAX_CANVAS_PIXELS + 50_000);
    });

    it("handles huge page geometries without falling below 0.75x", () => {
      expect(computeCanvasDpr(4000, 4000, 2, 2)).toBe(0.75);
    });
  });

  describe("computeMountedPagesWindow", () => {
    it("strictly evicts earlier pages once scrolling forward", () => {
      const win1 = computeMountedPagesWindow(1, 20, new Set([1]));
      expect([...win1].sort((a, b) => a - b)).toEqual([1, 2]);

      const win10 = computeMountedPagesWindow(10, 20, new Set([10]));
      expect([...win10].sort((a, b) => a - b)).toEqual([9, 10, 11]);
      expect(win10.has(1)).toBe(false);
    });

    it("retains intersecting pages alongside the buffer window", () => {
      const win = computeMountedPagesWindow(5, 20, new Set([3, 4, 5]), 1);
      expect([...win].sort((a, b) => a - b)).toEqual([3, 4, 5, 6]);
    });

    it("ignores out-of-bounds pages and empty documents", () => {
      expect(computeMountedPagesWindow(1, 0, new Set([1])).size).toBe(0);
      const win = computeMountedPagesWindow(3, 3, new Set([0, 3, 4]), 1);
      expect([...win].sort((a, b) => a - b)).toEqual([2, 3]);
    });
  });

  describe("diffEvictedPages & sameNumberSet", () => {
    it("computes evicted pages and compares sets accurately", () => {
      const prev = new Set([1, 2, 3, 4]);
      const next = new Set([3, 4, 5]);
      expect(diffEvictedPages(prev, next)).toEqual([1, 2]);
      expect(sameNumberSet(prev, next)).toBe(false);
      expect(sameNumberSet(new Set([3, 4, 5]), next)).toBe(true);
    });
  });
});
