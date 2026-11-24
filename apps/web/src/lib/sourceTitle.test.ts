import { describe, expect, it } from "vitest";
import { sanitizeSourceTitle } from "./sourceTitle";

describe("sanitizeSourceTitle", () => {
  it("cleans concatenated multi-mirror web/academic titles", () => {
    const dirty =
      "(PDF) ViHateT5: Enhancing Hate Speech Detection in ...ViHateT5: Enhancing Hate Speech Detection in Vietnamese With ...(PDF) ViHateT5: Enhancing Hate Speech Detection in Vietnamese ...tarudesu/ViHateT5-base-HSD · Hugging FaceViHateT5 - Vietnamese Hate Speech Detection with T5";
    const clean = sanitizeSourceTitle(dirty, { isAcademic: true });
    expect(clean).not.toContain("Hugging Face");
    expect(clean).not.toContain("(PDF)");
    expect(clean.startsWith("ViHateT5: Enhancing Hate Speech Detection in Vietnamese")).toBe(true);
  });

  it("strips arXiv preprint prefixes for academic works", () => {
    expect(sanitizeSourceTitle("[2405.14141] ViHateT5: Enhancing Hate Speech", { isAcademic: true })).toBe(
      "ViHateT5: Enhancing Hate Speech",
    );
  });

  it("removes glued duplicate repetitions without ellipses", () => {
    const title = "Neural Machine Translation in Low Resource Settings";
    expect(sanitizeSourceTitle(`${title}${title}`, { isAcademic: true })).toBe(title);
  });

  it("truncates overlong titles on word boundary with ellipsis", () => {
    const longTitle =
      "A Very Long Empirical Comparative Investigation Across Multiple Low Resource Southeast Asian Language Benchmarks and Pretrained Transformer Architectures";
    const cleaned = sanitizeSourceTitle(longTitle, { maxLength: 100 });
    expect(cleaned.length).toBeLessThanOrEqual(100);
    expect(cleaned.endsWith("…")).toBe(true);
  });
});
