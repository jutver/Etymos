import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PublishedPaperNotice } from "./PublishedPaperNotice";
import { parsePublishedPaperMatch } from "../../lib/publishedPaperMatch";

describe("PublishedPaperNotice", () => {
  it("renders nothing when publishedPaperMatch is absent or not detected", () => {
    const html = renderToStaticMarkup(createElement(PublishedPaperNotice, { match: undefined }));
    expect(html).toBe("");
  });

  it("renders paper title, authors, year, percentage, and link when detected", () => {
    const parsed = parsePublishedPaperMatch({
      detected: true,
      source_paper_id: "s2_456",
      source_title: "ViHateT5: Enhancing Hate Speech Detection",
      source_authors: ["Luan Thanh Nguyen", "Kiet Van Nguyen"],
      source_year: "2024",
      source_url: "https://arxiv.org/abs/2405.14141",
      coverage_percent: 91.4,
      title_matched: true,
    });

    const html = renderToStaticMarkup(createElement(PublishedPaperNotice, { match: parsed }));
    expect(html).toContain("This document appears to be the published paper itself");
    expect(html).toContain("91% of this document matches &quot;ViHateT5: Enhancing Hate Speech Detection&quot;.");
    expect(html).toContain("Luan Thanh Nguyen, Kiet Van Nguyen · 2024");
    expect(html).toContain('href="https://arxiv.org/abs/2405.14141"');
    expect(html).toContain("View published paper");
  });
});
