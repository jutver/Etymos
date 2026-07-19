import type { HistoryEntry } from "@etymos/shared";

/** A project "folder" for the Finder-style Documents screen. `documents.project`
 * is a plain nullable text column (no backing projects table), so a project
 * is purely a client-side grouping — `isDefault` marks the implicit
 * "ungrouped" bucket (PROJECTS[0] in lib/store.ts) that every user has and
 * that can't be renamed or deleted. */
export interface ProjectGroup {
  name: string;
  docs: HistoryEntry[];
  isDefault: boolean;
}

export type DocumentsViewMode = "list" | "icon";

export type ContextMenuState =
  | { kind: "project"; project: ProjectGroup; position: { x: number; y: number } }
  | { kind: "document"; doc: HistoryEntry; position: { x: number; y: number } };
