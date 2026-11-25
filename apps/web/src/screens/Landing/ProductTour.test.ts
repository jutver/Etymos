import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LazyMotion, domAnimation } from "motion/react";
import { describe, expect, it } from "vitest";
import { AUTO_ADVANCE_MS, ProductTour, nextTabKey, tabDirection } from "./ProductTour";

describe("ProductTour", () => {
  it("cycles cleanly through all 4 tabs on a 4-second interval", () => {
    expect(AUTO_ADVANCE_MS).toBe(4000);
    expect(nextTabKey("report")).toBe("why");
    expect(nextTabKey("why")).toBe("ai");
    expect(nextTabKey("ai")).toBe("rewrite");
    expect(nextTabKey("rewrite")).toBe("report");
  });

  it("picks directional slide orientation for forward, wrap, and backward jumps", () => {
    expect(tabDirection("report", "why")).toBe(1);
    expect(tabDirection("rewrite", "report")).toBe(1);
    expect(tabDirection("ai", "report")).toBe(-1);
    expect(tabDirection("report", "rewrite")).toBe(-1);
  });

  it("renders all 4 tabs, active progress bar, and initial panel under LazyMotion strict", () => {
    const html = renderToStaticMarkup(
      createElement(LazyMotion, { features: domAnimation, strict: true }, createElement(ProductTour)),
    );

    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("mk-tab-progress");
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain("Overall similarity");
  });
});
