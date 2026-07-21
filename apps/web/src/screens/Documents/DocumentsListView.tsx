import type { MouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import { CaretRight, FileText, FolderPlus, FolderSimple } from "@phosphor-icons/react";
import type { HistoryEntry } from "@etymos/shared";
import { formatDate, cn } from "@etymos/shared";
import { StatusPill } from "../../components/Severity";
import { CheckStatePill } from "./CheckStatePill";
import { analyzingStateFor } from "../../lib/documentsQueries";
import type { HistoryEntryWithCheck } from "../../lib/documentsQueries";
import type { ProjectGroup } from "./types";

interface DocumentsListViewProps {
  groups: ProjectGroup[];
  expanded: Set<string>;
  onToggleExpand: (name: string) => void;
  manageMode: boolean;
  selectedProjects: Set<string>;
  selectedDocs: Set<string>;
  onToggleSelectProject: (name: string) => void;
  onToggleSelectDoc: (id: string) => void;
  onProjectContextMenu: (e: MouseEvent, project: ProjectGroup) => void;
  onDocContextMenu: (e: MouseEvent, doc: HistoryEntry) => void;
  onCreateProject: () => void;
}

export function DocumentsListView({
  groups,
  expanded,
  onToggleExpand,
  manageMode,
  selectedProjects,
  selectedDocs,
  onToggleSelectProject,
  onToggleSelectDoc,
  onProjectContextMenu,
  onDocContextMenu,
  onCreateProject,
}: DocumentsListViewProps) {
  const navigate = useNavigate();

  /** Still-running checks have no report yet — open the progress view. */
  function openDoc(doc: HistoryEntryWithCheck) {
    if (doc.checkState === "checking") navigate("/analyzing", { state: analyzingStateFor(doc) });
    else navigate(`/report/${doc.id}`);
  }

  return (
    <div className="divide-y divide-line overflow-hidden rounded-[var(--radius-card-lg)] border border-line bg-white">
      <button
        type="button"
        onClick={onCreateProject}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-surface-tint"
      >
        <span className="flex size-8 items-center justify-center rounded-lg border border-dashed border-brand-300 text-brand-500">
          <FolderPlus size={16} />
        </span>
        <span className="text-sm font-semibold text-brand-600">Create project</span>
      </button>

      {groups.length === 0 && (
        <p className="px-5 py-12 text-center text-sm text-ink-400">No projects or documents match your search.</p>
      )}

      {groups.map((group) => {
        const isOpen = expanded.has(group.name);
        const isSelected = selectedProjects.has(group.name);
        return (
          <div key={group.name}>
            <div
              onContextMenu={(e) => {
                if (group.isDefault) return;
                e.preventDefault();
                onProjectContextMenu(e, group);
              }}
              className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-surface-tint"
            >
              {manageMode && !group.isDefault && (
                <input
                  type="checkbox"
                  aria-label={`Select ${group.name}`}
                  checked={isSelected}
                  onChange={() => onToggleSelectProject(group.name)}
                  className="size-4 shrink-0 rounded border-line text-brand-500 focus:ring-brand-300"
                />
              )}
              <button
                type="button"
                onClick={() => onToggleExpand(group.name)}
                className="flex flex-1 items-center gap-3 text-left"
                aria-expanded={isOpen}
              >
                <CaretRight
                  size={13}
                  weight="bold"
                  className={cn("shrink-0 text-ink-400 transition-transform", isOpen && "rotate-90")}
                />
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-100/60 text-brand-500">
                  <FolderSimple size={16} weight={isOpen ? "fill" : "regular"} />
                </span>
                <span className="truncate text-sm font-semibold text-ink-900">{group.name}</span>
                <span className="shrink-0 text-xs text-ink-400">
                  {group.docs.length} document{group.docs.length === 1 ? "" : "s"}
                </span>
              </button>
            </div>

            {isOpen && (
              <div className="border-t border-line bg-surface-tint/50">
                {group.docs.length === 0 ? (
                  <p className="px-16 py-3 text-xs text-ink-400">No documents in this project yet.</p>
                ) : (
                  group.docs.map((doc) => {
                    const docSelected = selectedDocs.has(doc.id);
                    return (
                      <div
                        key={doc.id}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          onDocContextMenu(e, doc);
                        }}
                        onClick={() => (manageMode ? onToggleSelectDoc(doc.id) : openDoc(doc))}
                        className="flex cursor-pointer items-center gap-3 border-t border-line/60 py-3 pl-16 pr-4 text-left transition-colors first:border-t-0 hover:bg-white"
                      >
                        {manageMode && (
                          <input
                            type="checkbox"
                            aria-label={`Select ${doc.title}`}
                            checked={docSelected}
                            onChange={() => onToggleSelectDoc(doc.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="size-4 shrink-0 rounded border-line text-brand-500 focus:ring-brand-300"
                          />
                        )}
                        <FileText size={16} className="shrink-0 text-ink-400" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-900">{doc.title}</span>
                        <span className="hidden shrink-0 text-xs text-ink-400 sm:inline">{formatDate(doc.date)}</span>
                        <span className="hidden shrink-0 text-xs font-semibold text-ink-700 sm:inline">
                          {doc.checkState === "completed" ? `${doc.similarityScore}%` : "—"}
                        </span>
                        {doc.checkState === "completed" ? (
                          <StatusPill status={doc.status} className="shrink-0" />
                        ) : (
                          <CheckStatePill state={doc.checkState} className="shrink-0" />
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
