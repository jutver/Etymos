// Inline bold/italic kept from the original file (DocPassage.textMarks) must
// render as <strong>/<em> — including inside a plagiarism highlight — and a
// passage without marks must render exactly as before.
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderPassageText } from "./renderPassageText";
import type { PassageSpan } from "./highlights";

const html = (node: ReturnType<typeof renderPassageText>) =>
  renderToStaticMarkup(createElement(Fragment, null, node));

const text = "We use PhoBERT for hate speech detection.";
const bold = { start: 7, end: 14, style: "bold" as const }; // "PhoBERT"
const italic = { start: 19, end: 30, style: "italic" as const }; // "hate speech"

describe("renderPassageText with text marks", () => {
  it("wraps marked ranges in <strong> and <em>", () => {
    const out = html(renderPassageText(text, [], new Map(), false, [bold, italic]));
    expect(out).toContain("<strong>PhoBERT</strong>");
    expect(out).toContain("<em>hate speech</em>");
    expect(out.replace(/<[^>]+>/g, "")).toBe(text);
  });

  it("keeps bold inside a plagiarism highlight", () => {
    const span: PassageSpan = { matchId: "m1", tone: "heavy", start: 3, end: 18, approximate: false };
    const out = html(renderPassageText(text, [span], new Map([["m1", 0]]), false, [bold]));
    expect(out).toMatch(/<mark[^>]*><span>use <\/span><strong>PhoBERT<\/strong><span> for<\/span><sup/);
  });

  it("renders unchanged when there are no marks", () => {
    expect(html(renderPassageText(text, [], new Map(), false))).toBe(`<span>${text}</span>`);
  });
});
