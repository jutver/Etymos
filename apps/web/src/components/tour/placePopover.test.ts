import { describe, expect, it } from "vitest";
import { placePopover } from "./placePopover";

const pop = { width: 300, height: 200 };
const viewport = { width: 1200, height: 800 };

describe("placePopover", () => {
  it("centres the card when there's nothing to point at", () => {
    expect(placePopover(null, pop, viewport)).toEqual({ top: 300, left: 450 });
  });

  it("goes below a box near the top", () => {
    expect(placePopover({ top: 20, left: 500, width: 100, height: 40 }, pop, viewport)).toEqual({ top: 74, left: 400 });
  });

  it("goes above a box near the bottom", () => {
    expect(placePopover({ top: 700, left: 500, width: 100, height: 40 }, pop, viewport)).toEqual({ top: 486, left: 400 });
  });

  it("goes beside a tall box", () => {
    expect(placePopover({ top: 0, left: 0, width: 240, height: 800 }, pop, viewport)).toEqual({ top: 300, left: 254 });
  });

  it("overlaps the lower edge of a box that fills the screen, inside the viewport", () => {
    const p = placePopover({ top: 0, left: 0, width: 1200, height: 800 }, pop, viewport);
    expect(p).toEqual({ top: 584, left: 450 });
  });

  it("never leaves the viewport sideways", () => {
    expect(placePopover({ top: 20, left: 1150, width: 40, height: 40 }, pop, viewport).left).toBe(884);
  });
});
