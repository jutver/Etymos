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
export type BlockKind = "paragraph" | "heading" | "list_item" | "table" | "image";

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
  level?: 1 | 2 | 3;
  listType?: "bullet" | "number";
  table?: TableData;
  imageUrl?: string;
  imageCaption?: string;
}

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
    if (kind === "heading") block.level = passage.blockType === "title" ? 1 : (passage.level ?? 2);
    if (kind === "list_item") block.listType = passage.listType ?? "bullet";
    if (kind === "table") block.table = tableDataFromRows(passage.tableRows, passage.text);
    if (kind === "image") {
      block.imageUrl = passage.imageUrl;
      block.imageCaption = passage.text;
    }
    return block;
  });
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
