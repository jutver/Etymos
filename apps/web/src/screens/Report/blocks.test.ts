import { describe, expect, it } from "vitest";
import type { DocPassage } from "@etymos/shared";
import { blocksFromRendered, computeListNumbers, groupBlocksIntoBands } from "./blocks";

const passage = (over: Partial<DocPassage>): DocPassage => ({ id: "p", text: "Text", ...over });
const blocks = (...passages: DocPassage[]) => blocksFromRendered(passages.map((p) => ({ passage: p, spans: [] })));

describe("blocks from passages", () => {
  it("styles the title and the subtitle apart from section headings", () => {
    const [title, subtitle, section] = blocks(
      passage({ id: "t", blockType: "title", level: 1, text: "Project Final Report" }),
      passage({ id: "s", blockType: "title", level: 2, text: "Voice Conversion using Disentanglement" }),
      passage({ id: "h", blockType: "heading", level: 2, text: "1 Introduction" }),
    );
    expect(title).toMatchObject({ kind: "heading", level: 1, variant: "title" });
    expect(subtitle).toMatchObject({ kind: "heading", level: 1, variant: "subtitle" });
    expect(section).toMatchObject({ kind: "heading", level: 2 });
    expect(section.variant).toBeUndefined();
  });

  it("treats a title passage without a level as the main title", () => {
    const [title] = blocks(passage({ blockType: "title", text: "A Report" }));
    expect(title.variant).toBe("title");
  });

  it("keeps fourth-level headings", () => {
    const [heading] = blocks(passage({ blockType: "heading", level: 4, text: "3.1.2 Cleaning" }));
    expect(heading.level).toBe(4);
  });

  it("keeps the picture of a table whose grid could not be read", () => {
    const [snapshot, grid] = blocks(
      passage({ id: "a", blockType: "table", text: "a | b", tableRows: [["a", "b"]], imageUrl: "https://x/table.png" }),
      passage({ id: "b", blockType: "table", text: "c | d", tableRows: [["c", "d"]] }),
    );
    expect(snapshot.imageUrl).toBe("https://x/table.png");
    expect(snapshot.table?.rows).toHaveLength(1);
    expect(grid.imageUrl).toBeUndefined();
  });

  it("propagates layout and list metadata onto DocBlock", () => {
    const [item] = blocks(
      passage({
        id: "li-1",
        blockType: "list_item",
        listType: "number",
        listNumber: 3,
        listDepth: 1,
        layoutBand: 2,
        columnRole: "left",
        columnCount: 2,
        page: 1,
      }),
    );
    expect(item).toMatchObject({
      kind: "list_item",
      listType: "number",
      listNumber: 3,
      listDepth: 1,
      layoutBand: 2,
      columnRole: "left",
      columnCount: 2,
    });
  });
});

describe("computeListNumbers", () => {
  it("numbers contiguous items sequentially across legacy reports missing listNumber", () => {
    const items = blocks(
      passage({ id: "l1", blockType: "list_item", listType: "number", text: "First" }),
      passage({ id: "l2", blockType: "list_item", listType: "number", text: "Second" }),
      passage({ id: "l3", blockType: "list_item", listType: "number", text: "Third" }),
      passage({ id: "p1", blockType: "paragraph", text: "Break" }),
      passage({ id: "l4", blockType: "list_item", listType: "number", text: "Restarted" }),
    );
    const numbers = computeListNumbers(items);
    expect(numbers.get("l1")).toBe(1);
    expect(numbers.get("l2")).toBe(2);
    expect(numbers.get("l3")).toBe(3);
    expect(numbers.get("l4")).toBe(1);
  });

  it("supports nested depths and resumes outer numbering", () => {
    const items = blocks(
      passage({ id: "o1", blockType: "list_item", listType: "number", listDepth: 0, text: "Outer 1" }),
      passage({ id: "i1", blockType: "list_item", listType: "number", listDepth: 1, text: "Inner 1" }),
      passage({ id: "i2", blockType: "list_item", listType: "number", listDepth: 1, text: "Inner 2" }),
      passage({ id: "o2", blockType: "list_item", listType: "number", listDepth: 0, text: "Outer 2" }),
      passage({ id: "i3", blockType: "list_item", listType: "number", listDepth: 1, text: "Inner 1 again" }),
    );
    const numbers = computeListNumbers(items);
    expect(numbers.get("o1")).toBe(1);
    expect(numbers.get("i1")).toBe(1);
    expect(numbers.get("i2")).toBe(2);
    expect(numbers.get("o2")).toBe(2);
    expect(numbers.get("i3")).toBe(1);
  });

  it("honors explicit non-decreasing start/gap numbers and renumbers cleanly after Edit drag-reorder", () => {
    const continued = blocks(
      passage({ id: "a", blockType: "list_item", listType: "number", listNumber: 4, text: "Four" }),
      passage({ id: "b", blockType: "list_item", listType: "number", listNumber: 5, text: "Five" }),
    );
    const continuedNums = computeListNumbers(continued);
    expect(continuedNums.get("a")).toBe(4);
    expect(continuedNums.get("b")).toBe(5);

    // Simulates dragging item 3 to top or item 1 to bottom.
    const reorderedTop = blocks(
      passage({ id: "c", blockType: "list_item", listType: "number", listNumber: 3, text: "Three" }),
      passage({ id: "a", blockType: "list_item", listType: "number", listNumber: 1, text: "One" }),
      passage({ id: "b", blockType: "list_item", listType: "number", listNumber: 2, text: "Two" }),
    );
    const reorderedTopNums = computeListNumbers(reorderedTop);
    expect([reorderedTopNums.get("c"), reorderedTopNums.get("a"), reorderedTopNums.get("b")]).toEqual([1, 2, 3]);

    const reorderedBottom = blocks(
      passage({ id: "b", blockType: "list_item", listType: "number", listNumber: 2, text: "Two" }),
      passage({ id: "c", blockType: "list_item", listType: "number", listNumber: 3, text: "Three" }),
      passage({ id: "a", blockType: "list_item", listType: "number", listNumber: 1, text: "One" }),
    );
    const reorderedBottomNums = computeListNumbers(reorderedBottom);
    expect([reorderedBottomNums.get("b"), reorderedBottomNums.get("c"), reorderedBottomNums.get("a")]).toEqual([1, 2, 3]);
  });
});

describe("groupBlocksIntoBands", () => {
  it("groups full-width headers separately from two-column bands and keeps legacy reports single-column", () => {
    const grouped = groupBlocksIntoBands(
      blocks(
        passage({ id: "t", blockType: "title", layoutBand: 0, columnRole: "full", columnCount: 1, page: 1 }),
        passage({ id: "abs", blockType: "paragraph", layoutBand: 0, columnRole: "full", columnCount: 1, page: 1 }),
        passage({ id: "l1", blockType: "paragraph", layoutBand: 1, columnRole: "left", columnCount: 2, page: 1 }),
        passage({ id: "r1", blockType: "paragraph", layoutBand: 1, columnRole: "right", columnCount: 2, page: 1 }),
        passage({ id: "l2", blockType: "paragraph", layoutBand: 0, columnRole: "left", columnCount: 2, page: 2 }),
      ),
    );
    expect(grouped).toHaveLength(3);
    expect(grouped[0]).toMatchObject({ kind: "single" });
    expect(grouped[0].kind === "single" ? grouped[0].blocks.map((b) => b.id) : []).toEqual(["t", "abs"]);
    expect(grouped[1]).toMatchObject({ kind: "columns", page: 1, band: 1 });
    if (grouped[1].kind === "columns") {
      expect(grouped[1].left.map((b) => b.id)).toEqual(["l1"]);
      expect(grouped[1].right.map((b) => b.id)).toEqual(["r1"]);
    }
    expect(grouped[2]).toMatchObject({ kind: "columns", page: 2, band: 0 });

    const legacy = groupBlocksIntoBands(blocks(passage({ id: "p1" }), passage({ id: "p2" })));
    expect(legacy).toHaveLength(1);
    expect(legacy[0].kind).toBe("single");
  });
});
