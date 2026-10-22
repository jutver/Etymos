import { describe, expect, it } from "vitest";
import { groupByFile } from "./fileGroups";

const e = (id: string, date: string, fileName?: string, title = "Doc") => ({ id, date, fileName, title });

describe("groupByFile", () => {
  it("collapses checks of the same file into one group, newest first", () => {
    const groups = groupByFile([
      e("v1", "2026-10-21T01:00:00Z", "Report.pdf", "Report"),
      e("v3", "2026-10-22T01:00:00Z", "Report.pdf", "Report.pdf"),
      e("v2", "2026-10-21T05:00:00Z", "Report.pdf", "Report"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].latest.id).toBe("v3");
    expect(groups[0].versions.map((v) => v.id)).toEqual(["v3", "v2", "v1"]);
  });

  it("falls back to the title for pasted text and sorts groups by latest check", () => {
    const groups = groupByFile([
      e("a", "2026-10-20T00:00:00Z", undefined, "Pasted"),
      e("b", "2026-10-22T00:00:00Z", "Other.docx"),
      e("c", "2026-10-21T00:00:00Z", "  ", "Pasted"),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["Other.docx", "Pasted"]);
    expect(groups[1].versions.map((v) => v.id)).toEqual(["c", "a"]);
  });
});
