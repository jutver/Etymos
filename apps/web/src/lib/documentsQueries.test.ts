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
