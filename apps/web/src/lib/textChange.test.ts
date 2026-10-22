import { describe, expect, it } from "vitest";
import { changedRatio, htmlToText } from "./textChange";

const words = (n: number, prefix = "w") => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");

// Mirrors backend/tests/test_recheck_quota.py, so both copies of the measure agree.
describe("changedRatio", () => {
  it("is zero for the same text, ignoring case, punctuation and spacing", () => {
    expect(changedRatio("Hello, world.\n\nSecond line here", "hello world\nSecond line here!")).toBe(0);
  });

  it("counts replaced and added words", () => {
    const base = words(100);
    expect(changedRatio(base, base.replace("w10 w11 w12", "new1 new2 new3"))).toBeCloseTo(0.03);
    expect(changedRatio(base, `${base}\n\n${words(20, "add")}`)).toBeCloseTo(0.2);
  });

  it("doesn't count pure deletions", () => {
    expect(changedRatio(`${words(100)}\n\n${words(100, "copied")}`, words(100))).toBe(0);
  });

  it("counts a whole new document fully, capped at 100%", () => {
    expect(changedRatio(words(100), words(300, "other"))).toBe(1);
  });

  it("finds one edit among many paragraphs", () => {
    const paras = Array.from({ length: 10 }, (_, i) => words(20, `p${i}_`));
    const edited = [...paras];
    edited[4] = edited[4].replace("p4_3", "changed");
    expect(changedRatio(paras.join("\n\n"), edited.join("\n\n"))).toBeCloseTo(1 / 200);
  });

  it("handles Vietnamese words", () => {
    const base = "Nghiên cứu này phân tích dữ liệu";
    expect(changedRatio(base, "Nghiên cứu này đánh giá dữ liệu")).toBeCloseTo(2 / 7);
  });

  it("handles empty text", () => {
    expect(changedRatio("", "")).toBe(0);
    expect(changedRatio("", "new")).toBe(1);
  });
});

describe("htmlToText", () => {
  it("strips tags without a DOM", () => {
    expect(htmlToText("<p>One</p><p>Two</p>").replace(/\s+/g, " ").trim()).toBe("One Two");
  });
});
