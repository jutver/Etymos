import { afterEach, describe, expect, it } from "vitest";
import type { RecheckQuote } from "../../lib/api";
import { setLanguage } from "../../lib/i18n";
import { changedPercent, collectEditorBlocks, recheckCostReason, recheckSummary } from "./recheck";

const quote = (over: Partial<RecheckQuote> = {}): RecheckQuote => ({
  tier: "free",
  changed_ratio: 0.12,
  change_limit: 0.3,
  free_used: 1,
  free_limit: 3,
  free_left: 2,
  cost: "free",
  ...over,
});

afterEach(() => setLanguage("en"));

describe("re-check quote copy", () => {
  it("describes a free re-check with what is left", () => {
    expect(recheckSummary(quote())).toBe("12% changed since your last full check · Free re-check (2 of 3 left)");
    expect(recheckCostReason(quote())).toBeNull();
  });

  it("says a paid re-check uses a check, and why", () => {
    const overLimit = quote({ changed_ratio: 0.34, cost: "check" });
    expect(recheckSummary(overLimit)).toBe("34% changed since your last full check — this re-check uses 1 check");
    expect(recheckCostReason(overLimit)).toContain("under 30%");

    const usedUp = quote({ free_used: 3, free_left: 0, cost: "check" });
    expect(recheckCostReason(usedUp)).toBe("You've used all 3 free re-checks since your last full check.");
  });

  it("rounds the percentage", () => {
    expect(changedPercent(quote({ changed_ratio: 0.296 }))).toBe(30);
  });

  it("is translated", () => {
    setLanguage("vi");
    expect(recheckSummary(quote())).toBe(
      "Đã thay đổi 12% so với lần kiểm tra đầy đủ gần nhất · Kiểm tra lại miễn phí (còn 2/3 lượt)",
    );
  });
});

/** Just enough of an element for collectEditorBlocks. */
function fakeBlock(id: string, text: string, parent: { closest: () => unknown } | null = null) {
  return {
    dataset: { blockId: id },
    innerText: text,
    parentElement: parent ?? { closest: () => null },
  };
}

describe("collectEditorBlocks", () => {
  it("reads top-level blocks in order, trimmed", () => {
    const outer = fakeBlock("p1", "  First paragraph.  ");
    const nested = fakeBlock("inner", "part of p1", { closest: () => outer });
    const image = fakeBlock("img", "");
    const editor = {
      querySelectorAll: () => [outer, nested, image, fakeBlock("p2", "Second.")],
    } as unknown as HTMLElement;

    expect(collectEditorBlocks(editor)).toEqual([
      { block_id: "p1", text: "First paragraph." },
      { block_id: "img", text: "" },
      { block_id: "p2", text: "Second." },
    ]);
  });
});

describe("version tags", () => {
  it("labels drafts and re-checked versions", async () => {
    const { versionTag } = await import("./versionStats");
    const base = { id: "v1", label: "Version 1", savedAt: "10:00", wordCount: 10, html: "" };
    expect(versionTag(base)).toBe("Draft");
    expect(versionTag({ ...base, check: { id: "c1", paid: false, score: 14.4, previousScore: null, aiScore: null, previousAiScore: null } })).toBe("Checked · 14%");
  });
});

describe("version history numbers", () => {
  it("shows how far each score moved", async () => {
    const { scoreChange } = await import("./versionStats");
    expect(scoreChange(14.4, 17.2)).toEqual({ value: 14, delta: -3 });
    expect(scoreChange(22, 22)).toEqual({ value: 22, delta: 0 });
    expect(scoreChange(30, null)).toEqual({ value: 30, delta: null });
    expect(scoreChange(null, 12)).toBeNull(); // AI detection didn't run
  });

  it("uses the stored change, else compares with the version before", async () => {
    const { versionChanges } = await import("./versionStats");
    const v = (id: string, html: string, changedRatio?: number | null) =>
      ({ id, label: id, savedAt: "", wordCount: 0, html, changedRatio });
    const changes = versionChanges([
      v("v3", "<p>one two three four</p>", 0.5),
      v("v2", "<p>one two three five</p>"),
      v("v1", "<p>one two three four</p>"),
    ]);
    expect(changes.get("v3")).toBe(0.5);
    expect(changes.get("v2")).toBeCloseTo(0.25);
    expect(changes.has("v1")).toBe(false); // nothing older to compare with
  });
});
