// Smoke tests for documentsQueries.ts: for each exported function, verify the
// empty-state (Supabase returns no rows -> resolves gracefully, doesn't throw)
// and the error-state (Supabase returns an error -> the error surfaces).
// The `@etymos/shared` Supabase client is mocked; nothing real is hit.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@etymos/shared", () => ({
  supabase: { from: vi.fn() },
}));

import { supabase } from "@etymos/shared";
import {
  fetchCheckedDocument,
  fetchDocumentVersions,
  fetchHistory,
  fetchUploadVersion,
  fetchVersionHistories,
  fetchTrash,
  moveDocumentToTrash,
  permanentlyDeleteDocument,
  restoreDocumentFromTrash,
} from "./documentsQueries";

type Result = { data: unknown; error: unknown };

/**
 * Builds a chainable stub mimicking supabase-js's PostgrestFilterBuilder:
 * `.select()/.eq()/.order()/.update()/.delete()` all return the same builder
 * (chainable), `.maybeSingle()` resolves directly, and the builder itself is
 * "thenable" so `await supabase.from(...).select(...).eq(...)` resolves to
 * `result` without an explicit terminal call.
 */
function makeBuilder(result: Result) {
  const builder: Record<string, unknown> = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    in: vi.fn(() => builder),
    not: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    update: vi.fn(() => builder),
    delete: vi.fn(() => builder),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (onFulfilled: (r: Result) => unknown, onRejected: (e: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return builder;
}

/** Configures `supabase.from(table)` to return a per-table builder/result. */
function mockFrom(byTable: Record<string, Result>) {
  (supabase.from as unknown as ReturnType<typeof vi.fn>).mockImplementation((table: string) =>
    makeBuilder(byTable[table] ?? { data: null, error: null }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchHistory", () => {
  it("returns an empty array when Supabase returns no rows", async () => {
    mockFrom({ documents: { data: [], error: null } });
    await expect(fetchHistory("user-1")).resolves.toEqual([]);
  });

  it("throws when Supabase returns an error", async () => {
    mockFrom({ documents: { data: null, error: new Error("boom") } });
    await expect(fetchHistory("user-1")).rejects.toThrow("boom");
  });
});

describe("fetchTrash", () => {
  it("returns an empty array when Supabase returns no rows", async () => {
    mockFrom({ documents: { data: [], error: null } });
    await expect(fetchTrash("user-1")).resolves.toEqual([]);
  });

  it("throws when Supabase returns an error", async () => {
    mockFrom({ documents: { data: null, error: new Error("boom") } });
    await expect(fetchTrash("user-1")).rejects.toThrow("boom");
  });
});

describe("fetchCheckedDocument", () => {
  it("returns null when the document is not found (empty state)", async () => {
    mockFrom({ documents: { data: null, error: null } });
    await expect(fetchCheckedDocument("doc-1")).resolves.toBeNull();
  });

  it("throws when the document lookup errors", async () => {
    mockFrom({ documents: { data: null, error: new Error("doc boom") } });
    await expect(fetchCheckedDocument("doc-1")).rejects.toThrow("doc boom");
  });

  it("throws when the matches lookup errors", async () => {
    mockFrom({
      documents: { data: { id: "doc-1", uploaded_at: "2026-01-01" }, error: null },
      document_matches: { data: null, error: new Error("matches boom") },
      document_passages: { data: [], error: null },
    });
    await expect(fetchCheckedDocument("doc-1")).rejects.toThrow("matches boom");
  });

  it("throws when the passages lookup errors", async () => {
    mockFrom({
      documents: { data: { id: "doc-1", uploaded_at: "2026-01-01" }, error: null },
      document_matches: { data: [], error: null },
      document_passages: { data: null, error: new Error("passages boom") },
    });
    await expect(fetchCheckedDocument("doc-1")).rejects.toThrow("passages boom");
  });

  it("returns an assembled document with empty matches/passages arrays", async () => {
    mockFrom({
      documents: { data: { id: "doc-1", uploaded_at: "2026-01-01" }, error: null },
      document_matches: { data: [], error: null },
      document_passages: { data: [], error: null },
    });
    const doc = await fetchCheckedDocument("doc-1");
    expect(doc).not.toBeNull();
    expect(doc?.matches).toEqual([]);
    expect(doc?.passages).toEqual([]);
  });

  it("handles legacy reports with null v2 columns as well as DOCX, pasted-text, and v2 formula documents", async () => {
    // Legacy report (pre-migration nulls, repeating list items without list_number)
    mockFrom({
      documents: { data: { id: "legacy-1", uploaded_at: "2025-12-01", file_name: null, extraction_meta: null }, error: null },
      document_matches: { data: [], error: null },
      document_passages: {
        data: [
          {
            id: "p1",
            text: "First legacy item",
            block_type: "list_item",
            list_type: "number",
            layout_band: null,
            column_role: null,
            column_count: null,
            list_number: null,
            list_depth: null,
            formula_latex: null,
            equation_number: null,
            inline_formulas: null,
          },
          {
            id: "p2",
            text: "Second legacy item",
            block_type: "list_item",
            list_type: "number",
          },
        ],
        error: null,
      },
    });
    const legacy = await fetchCheckedDocument("legacy-1");
    expect(legacy?.extractionMeta).toBeUndefined();
    expect(legacy?.passages).toHaveLength(2);
    expect(legacy?.passages[0]).toMatchObject({ id: "p1", blockType: "list_item", listType: "number" });
    expect(legacy?.passages[0].listNumber).toBeUndefined();
    expect(legacy?.passages[0].layoutBand).toBeUndefined();
    expect(legacy?.passages[1]).toMatchObject({ id: "p2", blockType: "list_item", listType: "number" });
    expect(legacy?.passages[1].listNumber).toBeUndefined();

    // V2 STEM report keeping zero-length formula block + inline formulas + extractionMeta
    mockFrom({
      documents: {
        data: {
          id: "v2-stem",
          uploaded_at: "2026-11-22",
          file_name: "stem.pdf",
          extraction_meta: {
            pipeline_version: 2,
            document_mode: "hybrid",
            total_pages: 3,
            ocr_pages: [2],
            multi_column_pages: [1, 2],
            formula_count: 1,
            formula_fallback_count: 0,
            warnings: ["page_3_illegible_scan"],
          },
        },
        error: null,
      },
      document_matches: { data: [], error: null },
      document_passages: {
        data: [
          {
            id: "intro-p",
            text: "Let x = 1 here.",
            block_type: "paragraph",
            layout_band: 1,
            column_role: "left",
            column_count: 2,
            inline_formulas: [{ start: 4, end: 9, latex: "x = 1" }],
          },
          {
            id: "eq-1",
            text: "",
            block_type: "formula",
            layout_band: 1,
            column_role: "left",
            column_count: 2,
            formula_latex: "E = mc^2",
            equation_number: "(1)",
          },
        ],
        error: null,
      },
    });
    const v2 = await fetchCheckedDocument("v2-stem");
    expect(v2?.extractionMeta).toMatchObject({
      pipelineVersion: 2,
      documentMode: "hybrid",
      ocrPages: [2],
      warnings: ["page_3_illegible_scan"],
    });
    expect(v2?.passages).toHaveLength(2);
    expect(v2?.passages[0].inlineFormulas).toEqual([{ start: 4, end: 9, latex: "x = 1" }]);
    expect(v2?.passages[1]).toMatchObject({
      id: "eq-1",
      blockType: "formula",
      formulaLatex: "E = mc^2",
      equationNumber: "(1)",
    });
  });
});

describe("moveDocumentToTrash", () => {
  it("resolves without throwing on success (empty response body)", async () => {
    mockFrom({ documents: { data: null, error: null } });
    await expect(moveDocumentToTrash("doc-1")).resolves.toBeUndefined();
  });

  it("throws when Supabase returns an error", async () => {
    mockFrom({ documents: { data: null, error: new Error("boom") } });
    await expect(moveDocumentToTrash("doc-1")).rejects.toThrow("boom");
  });
});

describe("restoreDocumentFromTrash", () => {
  it("resolves without throwing on success (empty response body)", async () => {
    mockFrom({ documents: { data: null, error: null } });
    await expect(restoreDocumentFromTrash("doc-1")).resolves.toBeUndefined();
  });

  it("throws when Supabase returns an error", async () => {
    mockFrom({ documents: { data: null, error: new Error("boom") } });
    await expect(restoreDocumentFromTrash("doc-1")).rejects.toThrow("boom");
  });
});

describe("permanentlyDeleteDocument", () => {
  it("resolves without throwing on success (empty response body)", async () => {
    mockFrom({ documents: { data: null, error: null } });
    await expect(permanentlyDeleteDocument("doc-1")).resolves.toBeUndefined();
  });

  it("throws when Supabase returns an error", async () => {
    mockFrom({ documents: { data: null, error: new Error("boom") } });
    await expect(permanentlyDeleteDocument("doc-1")).rejects.toThrow("boom");
  });
});

describe("restorable versions", () => {
  it("lists every saved version, not just the newest 20", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      id: `v${i}`, document_id: "d1", label: `Version ${25 - i}`, html: "<p>x</p>", word_count: 1,
      created_at: "2026-10-25T08:00:00Z",
    }));
    mockFrom({ document_versions: { data: rows, error: null }, document_checks: { data: [], error: null } });
    await expect(fetchDocumentVersions("d1")).resolves.toHaveLength(25);
  });

  it("offers the stored upload result as the original version", async () => {
    mockFrom({
      document_checks: { data: { id: "c0", similarity_score: 88.23, ai_score: null, baseline_text: "one two three" }, error: null },
    });
    const original = await fetchUploadVersion("d1");
    expect(original).toMatchObject({ label: "Original upload", wordCount: 3, check: { id: "c0", score: 88.23 } });
  });

  it("takes the History tab's upload score from the stored upload result, which is not a re-check", async () => {
    mockFrom({
      document_versions: { data: [], error: null },
      document_checks: {
        data: [{ document_id: "d1", version_id: null, kind: "upload", similarity_score: 88.23, previous_score: null }],
        error: null,
      },
    });
    const history = (await fetchVersionHistories(["d1"])).get("d1");
    expect(history).toMatchObject({ uploadScore: 88.23, rechecked: false });
  });
});
