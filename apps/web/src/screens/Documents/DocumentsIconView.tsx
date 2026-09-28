import type { MouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import { CaretLeft, FileText, FolderPlus, FolderSimple } from "@phosphor-icons/react";
import type { HistoryEntry } from "@etymos/shared";
import { cn } from "@etymos/shared";
import { formatDate } from "../../lib/format";
import { StatusPill } from "../../components/Severity";
import { CheckStatePill } from "./CheckStatePill";
import { analyzingStateFor } from "../../lib/documentsQueries";
import type { HistoryEntryWithCheck } from "../../lib/documentsQueries";
import type { ProjectGroup } from "./types";
import { t, tn } from "../../lib/i18n";

interface DocumentsIconViewProps {
  groups: ProjectGroup[];
  activeFolder: string | null;
  onOpenFolder: (name: string) => void;
  onBack: () => void;
  manageMode: boolean;
  selectedProjects: Set<string>;
  selectedDocs: Set<string>;
  onToggleSelectProject: (name: string) => void;
  onToggleSelectDoc: (id: string) => void;
  onProjectContextMenu: (e: MouseEvent, project: ProjectGroup) => void;
  onDocContextMenu: (e: MouseEvent, doc: HistoryEntry) => void;
  onCreateProject: () => void;
}

const GRID = "grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5";

function CardCheckbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      aria-label={t("Select {{label}}", { label: label })}
      checked={checked}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      className="absolute left-2.5 top-2.5 size-4 rounded border-line bg-white text-brand-500 focus:ring-brand-300"
    />
  );
}

export function DocumentsIconView({
  groups,
  activeFolder,
  onOpenFolder,
  onBack,
  manageMode,
  selectedProjects,
  selectedDocs,
  onToggleSelectProject,
  onToggleSelectDoc,
  onProjectContextMenu,
  onDocContextMenu,
  onCreateProject,
}: DocumentsIconViewProps) {
  const navigate = useNavigate();

  /** Still-running checks have no report yet — open the progress view. */
  function openDoc(doc: HistoryEntryWithCheck) {
    if (doc.checkState === "checking") navigate("/analyzing", { state: analyzingStateFor(doc) });
    else navigate(`/report/${doc.id}`);
  }

  if (activeFolder) {
    const group = groups.find((g) => g.name === activeFolder);
    const docs = group?.docs ?? [];
    return (
      <div>
        <button
          type="button"
          onClick={onBack}
          className="mb-4 flex items-center gap-1.5 text-sm font-semibold text-ink-500 hover:text-ink-900"
        >
          <CaretLeft size={14} weight="bold" />
          {t("All projects")}</button>
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-400">
          {activeFolder} &middot; {tn(docs.length, "{{count}} document", "{{count}} documents")}
        </p>

        {docs.length === 0 ? (
          <p className="rounded-[var(--radius-card-lg)] border border-dashed border-line bg-white px-5 py-12 text-center text-sm text-ink-400">
            {t("No documents in this project yet.")}</p>
        ) : (
          <div className={GRID}>
            {docs.map((doc) => {
              const docSelected = selectedDocs.has(doc.id);
              return (
                <div
                  key={doc.id}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onDocContextMenu(e, doc);
                  }}
                  onClick={() => (manageMode ? onToggleSelectDoc(doc.id) : openDoc(doc))}
                  className={cn(
                    "studio-card group relative flex aspect-square cursor-pointer flex-col items-center justify-center gap-2 rounded-[var(--radius-card-lg)] border bg-white p-4 text-center shadow-[var(--shadow-card)] transition-colors hover:border-brand-300",
                    docSelected ? "border-brand-400 ring-2 ring-brand-200" : "border-line",
                  )}
                >
                  {manageMode && (
                    <CardCheckbox
                      checked={docSelected}
                      onChange={() => onToggleSelectDoc(doc.id)}
                      label={doc.title}
                    />
                  )}
                  <span className="flex size-12 items-center justify-center rounded-xl bg-brand-100/60 text-brand-500">
                    <FileText size={22} />
                  </span>
                  <span className="line-clamp-2 w-full text-xs font-semibold text-ink-900">{doc.title}</span>
                  <span className="text-[11px] text-ink-400">{formatDate(doc.date)}</span>
                  {doc.checkState === "completed" ? (
                    <StatusPill status={doc.status} className="scale-90" />
                  ) : (
                    <CheckStatePill state={doc.checkState} className="scale-90" />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={GRID}>
      <button
        type="button"
        onClick={onCreateProject}
        className="studio-card flex aspect-square flex-col items-center justify-center gap-2 rounded-[var(--radius-card-lg)] border border-dashed border-brand-300 bg-white p-4 text-center transition-colors hover:bg-surface-tint"
      >
        <span className="flex size-12 items-center justify-center rounded-xl border border-dashed border-brand-300 text-brand-500">
          <FolderPlus size={22} />
        </span>
        <span className="text-xs font-semibold text-brand-600">{t("Create project")}</span>
      </button>

      {groups.map((group) => {
        const isSelected = selectedProjects.has(group.name);
        return (
          <div
            key={group.name}
            onContextMenu={(e) => {
              if (group.isDefault) return;
              e.preventDefault();
              onProjectContextMenu(e, group);
            }}
            onClick={() => (manageMode && !group.isDefault ? onToggleSelectProject(group.name) : onOpenFolder(group.name))}
            className={cn(
              "studio-card group relative flex aspect-square cursor-pointer flex-col items-center justify-center gap-2 rounded-[var(--radius-card-lg)] border bg-white p-4 text-center shadow-[var(--shadow-card)] transition-colors hover:border-brand-300",
              isSelected ? "border-brand-400 ring-2 ring-brand-200" : "border-line",
            )}
          >
            {manageMode && !group.isDefault && (
              <CardCheckbox
                checked={isSelected}
                onChange={() => onToggleSelectProject(group.name)}
                label={group.name}
              />
            )}
            <span className="flex size-12 items-center justify-center rounded-xl bg-brand-100/60 text-brand-500">
              <FolderSimple size={24} weight="fill" />
            </span>
            <span className="line-clamp-2 w-full text-xs font-semibold text-ink-900">{group.name}</span>
            <span className="text-[11px] text-ink-400">
              {tn(group.docs.length, "{{count}} document", "{{count}} documents")}
            </span>
          </div>
        );
      })}

      {groups.length === 0 && (
        <p className="col-span-full rounded-[var(--radius-card-lg)] border border-dashed border-line bg-white px-5 py-12 text-center text-sm text-ink-400">
          {t("No projects or documents match your search.")}</p>
      )}
    </div>
  );
}
