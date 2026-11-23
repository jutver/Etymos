import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { setLanguage } from "../../lib/i18n";
import { ExportVersionModal, type ExportVersionOption } from "./ExportVersionModal";

const sampleOptions: ExportVersionOption[] = [
  {
    key: "draft",
    kind: "draft",
    versionId: null,
    label: "Current Draft",
    createdAt: null,
    similarityScore: 28,
    aiScore: 15,
    isChecked: false,
    html: "<p>Edited draft</p>",
  },
  {
    key: "version:v1",
    kind: "saved",
    versionId: "v1",
    label: "Version 1",
    createdAt: "2026-11-23T12:00:00Z",
    similarityScore: 30,
    aiScore: 18,
    isChecked: true,
    html: "<p>Saved version</p>",
  },
  {
    key: "original",
    kind: "original",
    versionId: null,
    label: "Original Document",
    createdAt: "2026-11-23T10:00:00Z",
    similarityScore: 45,
    aiScore: 20,
    isChecked: true,
    html: null,
  },
];

describe("ExportVersionModal", () => {
  afterEach(() => {
    setLanguage("en");
  });

  it("renders all available version options and scores when open", () => {
    setLanguage("en");
    const html = renderToStaticMarkup(
      <ExportVersionModal
        open
        options={sampleOptions}
        selectedKey="version:v1"
        exporting={false}
        onSelect={vi.fn()}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(html).toContain("Choose version to export");
    expect(html).toContain("Current Draft");
    expect(html).toContain("Version 1");
    expect(html).toContain("Original Document");
    expect(html).toContain("Similarity 30%");
    expect(html).toContain("Not re-checked");
  });

  it("renders exporting state when exporting is true", () => {
    setLanguage("en");
    const html = renderToStaticMarkup(
      <ExportVersionModal
        open
        options={sampleOptions}
        selectedKey="original"
        exporting
        onSelect={vi.fn()}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(html).toContain("Exporting PDF…");
  });

  it("renders localized Vietnamese labels when language is vi", () => {
    setLanguage("vi");
    const html = renderToStaticMarkup(
      <ExportVersionModal
        open
        options={[
          { ...sampleOptions[0], label: "Bản nháp hiện tại" },
          { ...sampleOptions[2], label: "Tài liệu gốc" },
        ]}
        selectedKey="original"
        exporting={false}
        onSelect={vi.fn()}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(html).toContain("Chọn phiên bản để xuất");
    expect(html).toContain("Bản nháp hiện tại");
    expect(html).toContain("Tài liệu gốc");
    expect(html).toContain("Xuất PDF");
  });
});
