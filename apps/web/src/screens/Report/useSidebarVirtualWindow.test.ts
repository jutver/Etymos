import { describe, expect, it } from "vitest";
import { computeVirtualWindow } from "./useSidebarVirtualWindow";

describe("computeVirtualWindow", () => {
  it("handles an empty list cleanly", () => {
    const res = computeVirtualWindow({
      count: 0,
      scrollTop: 0,
      viewportHeight: 600,
      heights: [],
      defaultHeight: 230,
      overscan: 8,
      gap: 10,
    });
    expect(res.startIndex).toBe(0);
    expect(res.endIndex).toBe(0);
    expect(res.topSpacer).toBe(0);
    expect(res.bottomSpacer).toBe(0);
  });

  it("computes bounded visible range with overscan and spacers for 250 cards", () => {
    const count = 250;
    const heights = Array.from({ length: count }, (_, i) => (i === 50 ? 420 : 220));
    const res = computeVirtualWindow({
      count,
      scrollTop: 12000,
      viewportHeight: 680,
      heights,
      defaultHeight: 220,
      overscan: 4,
      gap: 10,
    });

    expect(res.startIndex).toBeGreaterThan(40);
    expect(res.endIndex - res.startIndex).toBeLessThan(20);
    expect(res.topSpacer).toBe(res.offsets[res.startIndex]);
    expect(res.bottomSpacer).toBeGreaterThan(0);
    expect(res.totalHeight).toBeGreaterThan(count * 220);
  });

  it("clamps cleanly at bottom of list with zero bottomSpacer", () => {
    const count = 100;
    const heights = Array.from({ length: count }, () => 200);
    const res = computeVirtualWindow({
      count,
      scrollTop: 25000,
      viewportHeight: 700,
      heights,
      defaultHeight: 200,
      overscan: 6,
      gap: 10,
    });
    expect(res.endIndex).toBe(100);
    expect(res.bottomSpacer).toBe(0);
  });
});
