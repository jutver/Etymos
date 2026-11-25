import type { CheckedDocument } from "@etymos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@etymos/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@etymos/shared")>();
  return {
    ...actual,
    supabase: {
      auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
      from: vi.fn(),
      rpc: vi.fn(),
    },
  };
});

import { useAppStore } from "./store";

function makeDoc(id: string, pdfUrl?: string): CheckedDocument {
  return {
    id,
    title: `Doc ${id}`,
    fileName: `${id}.pdf`,
    language: "en",
    wordCount: 100,
    uploadedAt: "2026-11-25",
    similarityScore: 10,
    similarityScoreFree: 10,
    webSourcesScanned: 1,
    academicSourcesScanned: 1,
    passages: [],
    matches: [],
    pdfUrl,
  };
}

describe("useAppStore recordCheckedDocument", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useAppStore.setState({ checkedDocuments: {} });
  });

  it("retains only the latest checked document and revokes evicted blob URLs", () => {
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    useAppStore.getState().recordCheckedDocument(makeDoc("d1", "blob:https://etymos.test/111"));
    expect(Object.keys(useAppStore.getState().checkedDocuments)).toEqual(["d1"]);
    expect(revokeSpy).not.toHaveBeenCalled();

    useAppStore.getState().recordCheckedDocument(makeDoc("d2", "blob:https://etymos.test/222"));
    expect(Object.keys(useAppStore.getState().checkedDocuments)).toEqual(["d2"]);
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    expect(revokeSpy).toHaveBeenCalledWith("blob:https://etymos.test/111");

    useAppStore.getState().recordCheckedDocument(makeDoc("d2", "blob:https://etymos.test/222"));
    expect(revokeSpy).toHaveBeenCalledTimes(1);
  });
});
