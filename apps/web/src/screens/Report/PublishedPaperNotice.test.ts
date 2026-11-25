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

  it("sanitizes concatenated multi-result titles and renders concise banner markup", () => {
    const dirtyTitle =
      "ViHateT5: Enhancing Hate Speech Detection in ...ViHateT5: Enhancing Hate Speech Detection in Vietnamese ...(PDF) ViHateT5: Enhancing Hate Speech Detection in Vietnamese ...tarudesu/ViHateT5-base-HSD · Hugging FaceViHateT5 - Vietnamese Hate Speech Detection with T5";

    const parsed = parsePublishedPaperMatch({
      detected: true,
      source_paper_id: "s2_456",
      source_title: dirtyTitle,
      source_authors: ["Luan Thanh Nguyen", "L. Nguyen", "Kiet Van Nguyen"],
      source_year: "2024",
      source_url: "https://arxiv.org/abs/2405.14141",
      coverage_percent: 96.4,
      title_matched: true,
    });

    expect(parsed?.sourceTitle).toBe("ViHateT5: Enhancing Hate Speech Detection in Vietnamese");

    const html = renderToStaticMarkup(createElement(PublishedPaperNotice, { match: parsed }));
    expect(html).toContain("Published paper match");
    expect(html).toContain("96% match");
    expect(html).toContain("ViHateT5: Enhancing Hate Speech Detection in Vietnamese");
    expect(html).not.toContain("Hugging Face");
    expect(html).toContain("Luan Thanh Nguyen, L. Nguyen · 2024");
    expect(html).toContain('href="https://arxiv.org/abs/2405.14141"');
    expect(html).toContain("View paper");
  });
});
