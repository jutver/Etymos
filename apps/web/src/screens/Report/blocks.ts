import { arrayMove } from "@dnd-kit/sortable";
import type { DocBlockType, DocPassage } from "@etymos/shared";
import type { PassageSpan, RenderedPassage } from "./highlights";

/**
 * The Document view's block model.
 *
 * Replaces the old single-`contentEditable`-HTML-blob approach: the document
 * is now an ordered array of typed, identity-bearing blocks so that
 * `@dnd-kit/sortable` has something stable to drag, and tables can carry real
 * structured state (columns/rows, widths) instead of a one-shot HTML dump.
 *
 * Maps directly onto `DocPassage` (packages/shared/src/types.ts) — every
 * block that came from the backend/Supabase keeps its originating `passage`
 * so highlight spans, severity and match linkage keep working unchanged.
 * Blocks the user inserts fresh (e.g. a new table from the toolbar) simply
 * have no `passage`.
 */
export type BlockKind = "paragraph" | "heading" | "list_item" | "table" | "image" | "formula";

export interface TableRow {
  id: string;
  cells: string[];
}

export interface TableData {
  columnIds: string[];
  /** Column widths in px, always the same length as `columnIds`. */
  colWidths: number[];
  rows: TableRow[];
}

export interface DocBlock {
  id: string;
  kind: BlockKind;
  /** Present when this block was derived from a backend/Supabase passage. */
  passage?: DocPassage;
  spans: PassageSpan[];
  level?: 1 | 2 | 3 | 4;
  /** Set on a heading that is the document's title or subtitle (a "title"
   * passage), which is styled apart from the section headings. */
  variant?: "title" | "subtitle";
  listType?: "bullet" | "number";
  listNumber?: number;
  listDepth?: number;
  layoutBand?: number;
  columnRole?: "full" | "left" | "right";
  columnCount?: 1 | 2;
  formulaLatex?: string;
  equationNumber?: string;
  table?: TableData;
  imageUrl?: string;
  imageCaption?: string;
}

export type LayoutBand =
  | { kind: "single"; key: string; blocks: DocBlock[] }
  | { kind: "columns"; key: string; page?: number; band?: number; left: DocBlock[]; right: DocBlock[] };

let idCounter = 0;

/** Stable, collision-safe id generator — no `crypto.randomUUID()` dependency. */
export function genId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}-${Math.random().toString(36).slice(2, 9)}`;
}

const DEFAULT_COL_WIDTH = 160;

function kindFromBlockType(blockType: DocBlockType | undefined): BlockKind {
  switch (blockType) {
    case "heading":
    case "title":
      return "heading";
    case "list_item":
      return "list_item";
    case "table":
      return "table";
    case "image":
      return "image";
    case "formula":
      return "formula";
    default:
      return "paragraph";
  }
}

function tableDataFromRows(rows: string[][] | undefined, fallbackText: string): TableData {
  const grid = rows && rows.length > 0 ? rows : [[fallbackText]];
  const colCount = Math.max(1, ...grid.map((r) => r.length));
  const columnIds = Array.from({ length: colCount }, () => genId("col"));
  return {
    columnIds,
    colWidths: Array.from({ length: colCount }, () => DEFAULT_COL_WIDTH),
    rows: grid.map((row) => ({
      id: genId("row"),
      cells: Array.from({ length: colCount }, (_, i) => row[i] ?? ""),
    })),
  };
}

/** Converts the highlight-resolved passages (see highlights.ts) into the
 * editable block array. One passage maps to exactly one block. */
export function blocksFromRendered(rendered: RenderedPassage[]): DocBlock[] {
  return rendered.map(({ passage, spans }) => {
    const kind = kindFromBlockType(passage.blockType);
    const block: DocBlock = { id: passage.id, kind, passage, spans };
    if (passage.layoutBand !== undefined) block.layoutBand = passage.layoutBand;
    if (passage.columnRole !== undefined) block.columnRole = passage.columnRole;
    if (passage.columnCount !== undefined) block.columnCount = passage.columnCount;
    if (kind === "heading" && passage.blockType === "title") {
      block.level = 1;
      block.variant = passage.level === 2 ? "subtitle" : "title";
    } else if (kind === "heading") {
      block.level = passage.level ?? 2;
    }
    if (kind === "list_item") {
      block.listType = passage.listType ?? "bullet";
      if (passage.listNumber !== undefined) block.listNumber = passage.listNumber;
      if (passage.listDepth !== undefined) block.listDepth = passage.listDepth;
    }
    if (kind === "table") {
      block.table = tableDataFromRows(passage.tableRows, passage.text);
      // A table read only as a picture of itself (see DocPassage.imageUrl).
      if (passage.imageUrl) block.imageUrl = passage.imageUrl;
    }
    if (kind === "image") {
      block.imageUrl = passage.imageUrl;
      block.imageCaption = passage.text;
    }
    if (kind === "formula") {
      if (passage.formulaLatex !== undefined) block.formulaLatex = passage.formulaLatex;
      if (passage.equationNumber !== undefined) block.equationNumber = passage.equationNumber;
      if (passage.imageUrl) block.imageUrl = passage.imageUrl;
    }
    return block;
  });
}

function hasNonMonotonicExplicitAhead(blocks: DocBlock[], startIndex: number, depth: number): boolean {
  let lastSeen: number | undefined;
  let sawOne = false;
  for (let j = startIndex; j < blocks.length; j += 1) {
    const b = blocks[j];
    if (b.kind !== "list_item") break;
    const d = Math.max(0, Math.min(4, b.listDepth ?? 0));
    if (d < depth) break;
    if (d > depth || b.listType !== "number") continue;
    const explicit = b.listNumber != null && b.listNumber >= 1 ? b.listNumber : undefined;
    if (explicit === undefined) continue;
    if (explicit === 1) sawOne = true;
    if (lastSeen !== undefined && explicit < lastSeen) return sawOne || true;
    lastSeen = explicit;
  }
  return false;
}

/** Compute sequential 1-based `<ol start>` values per numbered `list_item`
 * block across contiguous runs, supporting nested depths, legacy reports
 * lacking `listNumber`, and drag-reordered items in Edit mode. */
export function computeListNumbers(blocks: DocBlock[]): Map<string, number> {
  const result = new Map<string, number>();
  const counters = new Map<number, number>();
  let forceSequentialRunDepth: number | null = null;

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block.kind !== "list_item") {
      counters.clear();
      forceSequentialRunDepth = null;
      continue;
    }
    const depth = Math.max(0, Math.min(4, block.listDepth ?? 0));
    if (block.listType !== "number") {
      if (depth === 0) {
        counters.clear();
        forceSequentialRunDepth = null;
      } else {
        for (const k of [...counters.keys()]) {
          if (k >= depth) counters.delete(k);
        }
        if (forceSequentialRunDepth !== null && forceSequentialRunDepth >= depth) {
          forceSequentialRunDepth = null;
        }
      }
      continue;
    }

    for (const k of [...counters.keys()]) {
      if (k > depth) counters.delete(k);
    }
    if (forceSequentialRunDepth !== null && forceSequentialRunDepth > depth) {
      forceSequentialRunDepth = null;
    }

    const prev = counters.get(depth);
    let nextAtDepth: DocBlock | undefined;
    for (let j = i + 1; j < blocks.length; j += 1) {
      const candidate = blocks[j];
      if (candidate.kind !== "list_item") break;
      const cDepth = Math.max(0, Math.min(4, candidate.listDepth ?? 0));
      if (cDepth < depth) break;
      if (cDepth === depth) {
        if (candidate.listType === "number") nextAtDepth = candidate;
        break;
      }
    }

    const explicit = block.listNumber != null && block.listNumber >= 1 ? block.listNumber : undefined;
    const nextDecrease =
      explicit !== undefined &&
      nextAtDepth?.listNumber != null &&
      nextAtDepth.listNumber < explicit;

    if (prev === undefined && explicit !== undefined && (nextDecrease || hasNonMonotonicExplicitAhead(blocks, i, depth))) {
      forceSequentialRunDepth = depth;
    }

    let num: number;
    if (forceSequentialRunDepth === depth || nextDecrease) {
      num = (prev ?? 0) + 1;
    } else if (prev === undefined) {
      num = explicit ?? 1;
    } else {
      num = explicit !== undefined && explicit > prev ? explicit : prev + 1;
    }

    counters.set(depth, num);
    result.set(block.id, num);
  }
  return result;
}

function isTwoColumnBlock(block: DocBlock): boolean {
  return block.columnCount === 2 && (block.columnRole === "left" || block.columnRole === "right");
}

/** Partitions ordered `DocBlock[]` into contiguous full-width `"single"`
 * bands and side-by-side `"columns"` bands `(page, layoutBand)`. */
export function groupBlocksIntoBands(blocks: DocBlock[]): LayoutBand[] {
  const bands: LayoutBand[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (isTwoColumnBlock(block)) {
      const page = block.passage?.page;
      const band = block.layoutBand;
      const prev = bands[bands.length - 1];
      if (prev && prev.kind === "columns" && prev.page === page && prev.band === band) {
        if (block.columnRole === "right") prev.right.push(block);
        else prev.left.push(block);
      } else {
        bands.push({
          kind: "columns",
          key: `band-cols-${bands.length}-${block.id}`,
          page,
          band,
          left: block.columnRole === "right" ? [] : [block],
          right: block.columnRole === "right" ? [block] : [],
        });
      }
    } else {
      const prev = bands[bands.length - 1];
      if (prev && prev.kind === "single") {
        prev.blocks.push(block);
      } else {
        bands.push({
          kind: "single",
          key: `band-single-${bands.length}-${block.id}`,
          blocks: [block],
        });
      }
    }
  }
  return bands;
}

export function emptyTable(rows = 3, cols = 3): TableData {
  const columnIds = Array.from({ length: cols }, () => genId("col"));
  return {
    columnIds,
    colWidths: Array.from({ length: cols }, () => DEFAULT_COL_WIDTH),
    rows: Array.from({ length: rows }, () => ({
      id: genId("row"),
      cells: Array.from({ length: cols }, () => ""),
    })),
  };
}

export function newTableBlock(): DocBlock {
  return { id: genId("block"), kind: "table", spans: [], table: emptyTable() };
}

export function newParagraphBlock(): DocBlock {
  return { id: genId("block"), kind: "paragraph", spans: [] };
}

// --- Table structural edits ------------------------------------------------
// All pure: take a TableData, return a new one. Callers (TableBlock.tsx) wrap
// these in the block-array updater so unaffected blocks/rows never re-render.

function insertAt<T>(arr: T[], index: number, value: T): T[] {
  const copy = [...arr];
  copy.splice(index, 0, value);
  return copy;
}

export function insertRow(table: TableData, atIndex: number): TableData {
  const cols = table.columnIds.length;
  const row: TableRow = { id: genId("row"), cells: Array.from({ length: cols }, () => "") };
  return { ...table, rows: insertAt(table.rows, atIndex, row) };
}

export function removeRow(table: TableData, rowId: string): TableData {
  if (table.rows.length <= 1) return table;
  return { ...table, rows: table.rows.filter((r) => r.id !== rowId) };
}

export function insertColumn(table: TableData, atIndex: number): TableData {
  const columnIds = insertAt(table.columnIds, atIndex, genId("col"));
  const colWidths = insertAt(table.colWidths, atIndex, DEFAULT_COL_WIDTH);
  const rows = table.rows.map((r) => ({ ...r, cells: insertAt(r.cells, atIndex, "") }));
  return { ...table, columnIds, colWidths, rows };
}

export function removeColumn(table: TableData, colIndex: number): TableData {
  if (table.columnIds.length <= 1) return table;
  return {
    ...table,
    columnIds: table.columnIds.filter((_, i) => i !== colIndex),
    colWidths: table.colWidths.filter((_, i) => i !== colIndex),
    rows: table.rows.map((r) => ({ ...r, cells: r.cells.filter((_, i) => i !== colIndex) })),
  };
}

export function moveRow(table: TableData, fromId: string, toId: string): TableData {
  const from = table.rows.findIndex((r) => r.id === fromId);
  const to = table.rows.findIndex((r) => r.id === toId);
  if (from === -1 || to === -1 || from === to) return table;
  return { ...table, rows: arrayMove(table.rows, from, to) };
}

export function moveColumn(table: TableData, fromId: string, toId: string): TableData {
  const from = table.columnIds.indexOf(fromId);
  const to = table.columnIds.indexOf(toId);
  if (from === -1 || to === -1 || from === to) return table;
  return {
    ...table,
    columnIds: arrayMove(table.columnIds, from, to),
    colWidths: arrayMove(table.colWidths, from, to),
    rows: table.rows.map((r) => ({ ...r, cells: arrayMove(r.cells, from, to) })),
  };
}

export function setColWidth(table: TableData, colIndex: number, width: number): TableData {
  const colWidths = table.colWidths.map((w, i) => (i === colIndex ? Math.max(60, width) : w));
  return { ...table, colWidths };
}

export function setCell(table: TableData, rowId: string, colIndex: number, value: string): TableData {
  return {
    ...table,
    rows: table.rows.map((r) =>
      r.id === rowId ? { ...r, cells: r.cells.map((c, i) => (i === colIndex ? value : c)) } : r,
    ),
  };
}

/** Stable colour index per match, derived from sidebar ordering (moved here,
 * rather than living on DocumentCanvas, so block-rendering modules can import
 * it without creating a cycle back through DocumentCanvas.tsx). */
export type MatchColorIndex = Map<string, number>;
