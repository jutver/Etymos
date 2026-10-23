import { describe, expect, it } from "vitest";
import type { DocPassage } from "@etymos/shared";
import { blocksFromRendered } from "./blocks";

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
});
