// formatDate follows the UI language so Vietnamese users don't see "22 Sep 2026".
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "./i18n";
import { formatDate } from "./format";

afterEach(() => setLanguage("en"));

describe("formatDate", () => {
  it("uses English month names in English", () => {
    setLanguage("en");
    expect(formatDate("2026-09-22")).toMatch(/22 Sep/);
  });

  it("uses Vietnamese month names in Vietnamese", () => {
    setLanguage("vi");
    const out = formatDate("2026-09-22");
    expect(out).toMatch(/22/);
    expect(out).toMatch(/thg 9|tháng 9/i);
    expect(out).not.toMatch(/Sep/);
  });
});
