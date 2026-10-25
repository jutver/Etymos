import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./documentsQueries", () => ({ saveDocumentVersion: vi.fn() }));

import { saveDocumentVersion } from "./documentsQueries";
import { loadLocalDocumentVersions, saveLocalDocumentVersion, uploadLocalDocumentVersions } from "./localDocumentVersions";

const save = saveDocumentVersion as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  save.mockReset();
});

function keep(label: string) {
  return saveLocalDocumentVersion("d1", { label, html: `<p>${label}</p>`, wordCount: 1 });
}

describe("uploadLocalDocumentVersions", () => {
  it("moves device-only versions to the database, oldest first, keeping their save time", async () => {
    keep("Version 1");
    keep("Version 2");
    save.mockResolvedValue({});
    await uploadLocalDocumentVersions("d1");
    expect(save.mock.calls.map(([, v]) => v.label)).toEqual(["Version 1", "Version 2"]);
    expect(save.mock.calls[0][1].createdAt).toEqual(expect.any(String));
    expect(loadLocalDocumentVersions("d1")).toEqual([]);
  });

  it("keeps what the database still refuses for the next try", async () => {
    keep("Version 1");
    keep("Version 2");
    save.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("offline"));
    await uploadLocalDocumentVersions("d1");
    expect(loadLocalDocumentVersions("d1").map((v) => v.label)).toEqual(["Version 2"]);
  });

  it("keeps more than 20 versions on the device", () => {
    for (let i = 1; i <= 25; i += 1) keep(`Version ${i}`);
    expect(loadLocalDocumentVersions("d1")).toHaveLength(25);
  });
});
