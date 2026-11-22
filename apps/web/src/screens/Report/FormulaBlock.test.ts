import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FormulaBlock, renderSafeKatex } from "./FormulaBlock";

describe("FormulaBlock & renderSafeKatex", () => {
  it("renders synchronous KaTeX HTML for valid display and inline formulas", () => {
    const displayHtml = renderSafeKatex(String.raw`\frac{a + b}{c}`, true);
    expect(displayHtml).not.toBeNull();
    expect(displayHtml).toContain("katex-display");
    expect(displayHtml).toContain("<math");

    const inlineHtml = renderSafeKatex(String.raw`\alpha \in \mathbb{R}`, false);
    expect(inlineHtml).not.toBeNull();
    expect(inlineHtml).toContain("katex");
    expect(inlineHtml).not.toContain("katex-display");
  });

  it("strips unsafe HTML/script attributes while keeping KaTeX math intact", () => {
    const rendered = renderSafeKatex(
      String.raw`\href{javascript:alert(1)}{x} + \text{<script>alert(1)</script>}`,
      false,
    );
    expect(rendered).not.toBeNull();
    expect(rendered).not.toContain("<script");
    expect(rendered).not.toContain("javascript:");
    expect(rendered).not.toContain("onerror=");
  });

  it("renders FormulaBlock with KaTeX display math and right-aligned equation number", () => {
    const html = renderToStaticMarkup(
      createElement(FormulaBlock, {
        formulaLatex: String.raw`E = mc^2`,
        equationNumber: "(1)",
      }),
    );
    expect(html).toContain('role="math"');
    expect(html).toContain('contentEditable="false"');
    expect(html).toContain("katex-display");
    expect(html).toContain("(1)");
  });

  it("falls back cleanly to cropped equation image and then monospace text", () => {
    const imgHtml = renderToStaticMarkup(
      createElement(FormulaBlock, {
        imageUrl: "https://cdn.example/eq1.png",
        equationNumber: "(2)",
      }),
    );
    expect(imgHtml).toContain('<img src="https://cdn.example/eq1.png"');
    expect(imgHtml).toContain("(2)");

    const monoHtml = renderToStaticMarkup(
      createElement(FormulaBlock, {
        fallbackText: "x = y + z",
      }),
    );
    expect(monoHtml).toContain("<code");
    expect(monoHtml).toContain("x = y + z");
  });

  it("returns cached identical sanitized output for repeated expressions", () => {
    const first = renderSafeKatex(String.raw`\sum_{i=1}^n x_i`, false);
    const second = renderSafeKatex(String.raw`\sum_{i=1}^n x_i`, false);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });
});
