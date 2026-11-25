import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LazyMotion, domAnimation } from "motion/react";
import { describe, expect, it, vi } from "vitest";
import {
  PDF_ZOOM_PRESETS,
  PdfZoomControl,
  clampZoomPercent,
  parseZoomPercent,
  stepZoomPercent,
} from "./PdfZoomControl";

function renderZoomControl(props: Parameters<typeof PdfZoomControl>[0]) {
  return renderToStaticMarkup(
    createElement(
      LazyMotion,
      { features: domAnimation, strict: true },
      createElement(PdfZoomControl, props),
    ),
  );
}

describe("PdfZoomControl", () => {
  it("parses and clamps typed zoom percentages safely", () => {
    expect(parseZoomPercent("125")).toBe(125);
    expect(parseZoomPercent(" 75% ")).toBe(75);
    expect(parseZoomPercent("10")).toBe(25);
    expect(parseZoomPercent("500")).toBe(300);
    expect(clampZoomPercent(175.4)).toBe(175);

    expect(parseZoomPercent("")).toBeNull();
    expect(parseZoomPercent("abc")).toBeNull();
    expect(parseZoomPercent("0")).toBeNull();
  });

  it("steps cleanly to the next or previous zoom stop", () => {
    expect(stepZoomPercent(175, "out")).toBe(150);
    expect(stepZoomPercent(175, "in")).toBe(200);
    expect(stepZoomPercent(137, "in")).toBe(150);
    expect(stepZoomPercent(137, "out")).toBe(125);
    expect(stepZoomPercent(25, "out")).toBe(25);
    expect(stepZoomPercent(300, "in")).toBe(300);
  });

  it("renders editable combobox input and hides preset listbox when closed", () => {
    const html = renderZoomControl({
      percent: 175,
      onChangePercent: vi.fn(),
    });

    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-label="Zoom level"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('value="175"');
    expect(html).toContain(">%<");
    expect(html).toContain('aria-label="Zoom presets"');
    expect(html).not.toContain('role="listbox"');
  });

  it("renders all 7 preset zoom options and marks the active preset when open", () => {
    const html = renderZoomControl({
      percent: 125,
      defaultOpen: true,
      onChangePercent: vi.fn(),
    });

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('role="listbox"');

    for (const preset of PDF_ZOOM_PRESETS) {
      expect(html).toContain(`>${preset}%<`);
    }

    const selectedMatches = html.match(/aria-selected="true"/g);
    expect(selectedMatches?.length).toBe(1);
    expect(html).toMatch(/aria-selected="true"[^>]*>[\s\S]*?125%/);
  });
});
