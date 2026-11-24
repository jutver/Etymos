import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LazyMotion, domAnimation } from "motion/react";
import { describe, expect, it, vi } from "vitest";
import { PdfThumbnailRail } from "./PdfThumbnailRail";

describe("PdfThumbnailRail", () => {
  it("renders animated thumbnail tiles, active pill marker, match indicator dots, and skeletons when open", () => {
    const pageIndicatorClasses = new Map<number, string[]>([
      [1, ["bg-red-500", "bg-amber-500"]],
    ]);

    const html = renderToStaticMarkup(
      createElement(
        LazyMotion,
        { features: domAnimation, strict: true },
        createElement(PdfThumbnailRail, {
          pdf: null,
          numPages: 3,
          currentPage: 2,
          open: true,
          onSelectPage: vi.fn(),
          pageIndicatorClasses,
        }),
      ),
    );

    expect(html).toContain('aria-label="Page thumbnails"');
    expect(html).toContain('data-thumb-page="1"');
    expect(html).toContain('data-thumb-page="2"');
    expect(html).toContain('data-thumb-page="3"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('data-pill-active="true"');
    expect(html).toContain("bg-red-500");
    expect(html).toContain("bg-amber-500");
    expect(html).toContain("data-thumb-skeleton");
  });

  it("renders empty when closed or when the document has a single page", () => {
    const closedHtml = renderToStaticMarkup(
      createElement(
        LazyMotion,
        { features: domAnimation, strict: true },
        createElement(PdfThumbnailRail, {
          pdf: null,
          numPages: 3,
          currentPage: 1,
          open: false,
          onSelectPage: vi.fn(),
        }),
      ),
    );
    const singlePageHtml = renderToStaticMarkup(
      createElement(
        LazyMotion,
        { features: domAnimation, strict: true },
        createElement(PdfThumbnailRail, {
          pdf: null,
          numPages: 1,
          currentPage: 1,
          open: true,
          onSelectPage: vi.fn(),
        }),
      ),
    );

    expect(closedHtml).toBe("");
    expect(singlePageHtml).toBe("");
  });
});
