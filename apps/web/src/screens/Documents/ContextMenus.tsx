import { useState, type ReactNode } from "react";
import { CaretLeft, FolderSimple, PencilSimple, Trash } from "@phosphor-icons/react";
import type { HistoryEntry } from "@etymos/shared";
import { cn } from "@etymos/shared";
import { ContextMenu } from "../../components/ui/ContextMenu";
import { PROJECTS } from "../../lib/store";
import type { ContextMenuState, ProjectGroup } from "./types";
import { t } from "../../lib/i18n";

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors",
        danger ? "text-severity-high hover:bg-severity-high-bg" : "text-ink-700 hover:bg-surface-tint",
      )}
    >
      {icon}
      {t(label)}
    </button>
  );
}

type ProjectMenuState = Extract<ContextMenuState, { kind: "project" }>;
type DocumentMenuState = Extract<ContextMenuState, { kind: "document" }>;

export function ProjectContextMenu({
  state,
  onClose,
  onRename,
  onDelete,
}: {
  state: ProjectMenuState | null;
  onClose: () => void;
  onRename: (project: ProjectGroup) => void;
  onDelete: (project: ProjectGroup) => void;
}) {
  const project = state?.project ?? null;
  return (
    <ContextMenu open={!!state} onClose={onClose} position={state?.position ?? { x: 0, y: 0 }}>
      {project && (
        <>
          <MenuItem
            icon={<PencilSimple size={16} />}
            label={t("Rename")}
            onClick={() => {
              onRename(project);
              onClose();
            }}
          />
          <MenuItem
            icon={<Trash size={16} />}
            label={t("Delete")}
            danger
            onClick={() => {
              onDelete(project);
              onClose();
            }}
          />
        </>
      )}
    </ContextMenu>
  );
}

export function DocumentContextMenu({
  state,
  projectNames,
  onClose,
  onRename,
  onDelete,
  onMove,
}: {
  state: DocumentMenuState | null;
  projectNames: string[];
  onClose: () => void;
  onRename: (doc: HistoryEntry) => void;
  onDelete: (doc: HistoryEntry) => void;
  onMove: (doc: HistoryEntry, project: string) => void;
}) {
  const [mode, setMode] = useState<"main" | "move">("main");
  const doc = state?.doc ?? null;

  function handleClose() {
    setMode("main");
    onClose();
  }

  const currentProject = doc?.project ?? PROJECTS[0];
  const otherProjects = projectNames.filter((p) => p !== currentProject);

  return (
    <ContextMenu open={!!state} onClose={handleClose} position={state?.position ?? { x: 0, y: 0 }}>
      {doc && mode === "main" && (
        <>
          <MenuItem
            icon={<PencilSimple size={16} />}
            label={t("Rename")}
            onClick={() => {
              onRename(doc);
              handleClose();
            }}
          />
          <MenuItem
            icon={<FolderSimple size={16} />}
            label={t("Move to project…")}
            onClick={() => setMode("move")}
          />
          <MenuItem
            icon={<Trash size={16} />}
            label={t("Delete")}
            danger
            onClick={() => {
              onDelete(doc);
              handleClose();
            }}
          />
        </>
      )}

      {doc && mode === "move" && (
        <>
          <button
            type="button"
            onClick={() => setMode("main")}
            className="flex w-full items-center gap-1.5 rounded-lg px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-400 hover:bg-surface-tint"
          >
            <CaretLeft size={12} />{" "}{t("Back")}</button>
          <div className="my-1 h-px bg-line" />
          <div className="max-h-56 overflow-y-auto">
            {otherProjects.length === 0 && (
              <p className="px-3 py-2 text-xs text-ink-400">{t("No other projects yet.")}</p>
            )}
            {otherProjects.map((p) => (
              <MenuItem
                key={p}
                icon={<FolderSimple size={16} />}
                label={p}
                onClick={() => {
                  onMove(doc, p);
                  handleClose();
                }}
              />
            ))}
          </div>
        </>
      )}
    </ContextMenu>
  );
}
