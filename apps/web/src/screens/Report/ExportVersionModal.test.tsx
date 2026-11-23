import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
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
  it("renders all available version options and scores when open", () => {
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
});
