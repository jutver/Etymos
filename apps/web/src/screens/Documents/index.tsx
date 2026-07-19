import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { MagnifyingGlass, Trash } from "@phosphor-icons/react";
import type { HistoryEntry } from "@etymos/shared";
import { useAppStore, PROJECTS } from "../../lib/store";
import { useAuth } from "../../lib/auth";
import { Button } from "../../components/ui/Button";
import {
  clearProjectFromDocuments,
  moveDocumentToProject,
  renameDocument,
  renameProjectDocuments,
} from "../../lib/documentsQueries";
import { ViewModeToggle } from "./ViewModeToggle";
import { DocumentsListView } from "./DocumentsListView";
import { DocumentsIconView } from "./DocumentsIconView";
import { ProjectContextMenu, DocumentContextMenu } from "./ContextMenus";
import { PromptModal } from "./PromptModal";
import { ConfirmDialog } from "./ConfirmDialog";
import type { ContextMenuState, DocumentsViewMode, ProjectGroup } from "./types";

type PromptState =
  | { kind: "create-project" }
  | { kind: "rename-project"; project: ProjectGroup }
  | { kind: "rename-document"; doc: HistoryEntry }
  | null;

type ConfirmState =
  | { kind: "delete-project"; project: ProjectGroup }
  | { kind: "delete-document"; doc: HistoryEntry }
  | { kind: "bulk-delete" }
  | null;

export default function DocumentsPage() {
  const { user } = useAuth();
  const history = useAppStore((s) => s.history);
  const historyLoading = useAppStore((s) => s.historyLoading);
  const historyError = useAppStore((s) => s.historyError);
  const fetchHistory = useAppStore((s) => s.fetchHistory);
  const knownProjects = useAppStore((s) => s.knownProjects);
  const addKnownProject = useAppStore((s) => s.addKnownProject);
  const removeKnownProject = useAppStore((s) => s.removeKnownProject);
  const renameProjectInHistory = useAppStore((s) => s.renameProjectInHistory);
  const clearProjectInHistory = useAppStore((s) => s.clearProjectInHistory);
  const setDocumentProject = useAppStore((s) => s.setDocumentProject);
  const renameDocumentInHistory = useAppStore((s) => s.renameDocumentInHistory);
  const moveToTrash = useAppStore((s) => s.moveToTrash);
  const pushToast = useAppStore((s) => s.pushToast);

  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<DocumentsViewMode>("list");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([PROJECTS[0]]));
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [manageMode, setManageMode] = useState(false);
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [prompt, setPrompt] = useState<PromptState>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    void fetchHistory(user.id);
  }, [user?.id, fetchHistory]);

  const groups = useMemo<ProjectGroup[]>(() => {
    const q = query.trim().toLowerCase();
    const byName = new Map<string, HistoryEntry[]>();
    byName.set(PROJECTS[0], []);
    for (const name of knownProjects) if (!byName.has(name)) byName.set(name, []);

    for (const h of history) {
      const name = h.project ?? PROJECTS[0];
      if (q && !h.title.toLowerCase().includes(q) && !name.toLowerCase().includes(q)) continue;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name)!.push(h);
    }

    const names = [...byName.keys()].sort((a, b) => {
      if (a === PROJECTS[0]) return -1;
      if (b === PROJECTS[0]) return 1;
      return a.localeCompare(b);
    });

    return names
      .map((name) => ({ name, docs: byName.get(name)!, isDefault: name === PROJECTS[0] }))
      .filter((g) => !q || g.docs.length > 0 || g.name.toLowerCase().includes(q));
  }, [history, knownProjects, query]);

  const allProjectNames = useMemo(() => groups.map((g) => g.name), [groups]);

  function toggleExpand(name: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleManageMode() {
    setManageMode((v) => !v);
    setSelectedProjects(new Set());
    setSelectedDocs(new Set());
  }

  function toggleSelectProject(name: string) {
    setSelectedProjects((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleSelectDoc(id: string) {
    setSelectedDocs((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function openProjectMenu(e: MouseEvent, project: ProjectGroup) {
    setContextMenu({ kind: "project", project, position: { x: e.clientX, y: e.clientY } });
  }

  function openDocMenu(e: MouseEvent, doc: HistoryEntry) {
    setContextMenu({ kind: "document", doc, position: { x: e.clientX, y: e.clientY } });
  }

  async function handleCreateProject(name: string) {
    if (name === PROJECTS[0] || allProjectNames.includes(name)) {
      pushToast({ kind: "error", title: "A project with that name already exists." });
      return;
    }
    addKnownProject(name);
    setExpanded((s) => new Set(s).add(name));
    setPrompt(null);
    pushToast({ kind: "success", title: `Created project "${name}"` });
  }

  async function handleRenameProject(oldName: string, newName: string) {
    if (newName === oldName) {
      setPrompt(null);
      return;
    }
    if (newName === PROJECTS[0] || allProjectNames.includes(newName)) {
      pushToast({ kind: "error", title: "A project with that name already exists." });
      return;
    }
    setBusy(true);
    try {
      if (user?.id) await renameProjectDocuments(user.id, oldName, newName);
      renameProjectInHistory(oldName, newName);
      setExpanded((s) => {
        if (!s.has(oldName)) return s;
        const next = new Set(s);
        next.delete(oldName);
        next.add(newName);
        return next;
      });
      pushToast({ kind: "success", title: `Renamed to "${newName}"` });
      setPrompt(null);
    } catch {
      pushToast({ kind: "error", title: "Couldn't rename project", description: "Please try again." });
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteProject(project: ProjectGroup) {
    setBusy(true);
    try {
      if (user?.id) await clearProjectFromDocuments(user.id, project.name);
      clearProjectInHistory(project.name);
      removeKnownProject(project.name);
      pushToast({
        kind: "info",
        title: `Deleted project "${project.name}"`,
        description: project.docs.length > 0 ? "Its documents were moved to Default." : undefined,
      });
      setConfirm(null);
    } catch {
      pushToast({ kind: "error", title: "Couldn't delete project", description: "Please try again." });
    } finally {
      setBusy(false);
    }
  }

  async function handleRenameDocument(doc: HistoryEntry, title: string) {
    setBusy(true);
    try {
      await renameDocument(doc.id, title);
      renameDocumentInHistory(doc.id, title);
      pushToast({ kind: "success", title: "Document renamed" });
      setPrompt(null);
    } catch {
      pushToast({ kind: "error", title: "Couldn't rename document", description: "Please try again." });
    } finally {
      setBusy(false);
    }
  }

  async function handleMoveDocument(doc: HistoryEntry, project: string) {
    setBusy(true);
    try {
      const target = project === PROJECTS[0] ? null : project;
      await moveDocumentToProject(doc.id, target);
      setDocumentProject(doc.id, target);
      pushToast({ kind: "success", title: `Moved to "${project}"` });
    } catch {
      pushToast({ kind: "error", title: "Couldn't move document", description: "Please try again." });
    } finally {
      setBusy(false);
    }
  }

  function handleDeleteDocument(doc: HistoryEntry) {
    moveToTrash(doc.id);
    pushToast({ kind: "info", title: "Moved to trash", description: "Restore it anytime from My Trash." });
    setConfirm(null);
  }

  function handleBulkDelete() {
    for (const id of selectedDocs) moveToTrash(id);
    for (const name of selectedProjects) {
      const group = groups.find((g) => g.name === name);
      if (!group) continue;
      void clearProjectFromDocuments(user!.id, name).catch(() => {});
      clearProjectInHistory(name);
      removeKnownProject(name);
    }
    pushToast({
      kind: "info",
      title: "Deleted selected items",
      description: selectedDocs.size > 0 ? "Documents were moved to My Trash." : undefined,
    });
    setSelectedDocs(new Set());
    setSelectedProjects(new Set());
    setConfirm(null);
  }

  const selectionCount = selectedDocs.size + selectedProjects.size;

  return (
    <div className="mx-auto max-w-7xl px-5 py-10 sm:px-8">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-h1 font-bold tracking-tight text-navy-900">Documents</h1>
          <p className="mt-1.5 text-sm text-ink-500">Organize your checks into projects, Finder-style.</p>
        </div>
        <div className="flex items-center gap-2">
          <ViewModeToggle
            value={viewMode}
            onChange={(mode) => {
              setViewMode(mode);
              setActiveFolder(null);
            }}
          />
          <Button variant={manageMode ? "secondary" : "outline"} size="sm" onClick={toggleManageMode}>
            {manageMode ? "Done" : "Manage"}
          </Button>
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:w-72">
          <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-300" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects and documents..."
            className="w-full rounded-full border border-line bg-white py-2 pl-9 pr-4 text-sm placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
          />
        </div>

        {manageMode && selectionCount > 0 && (
          <div className="flex items-center gap-3 rounded-full border border-line bg-white py-1.5 pl-4 pr-1.5 text-sm">
            <span className="font-medium text-ink-700">{selectionCount} selected</span>
            <Button variant="danger" size="sm" iconLeft={<Trash size={14} />} onClick={() => setConfirm({ kind: "bulk-delete" })}>
              Delete
            </Button>
          </div>
        )}
      </div>

      <div className="mt-4">
        {historyLoading && history.length === 0 && (
          <div className="rounded-[var(--radius-card-lg)] border border-line bg-white px-5 py-12 text-center text-sm text-ink-400">
            Loading documents…
          </div>
        )}

        {historyError && (
          <div className="rounded-[var(--radius-card-lg)] border border-severity-high-line bg-severity-high-bg px-5 py-12 text-center text-sm text-severity-high">
            {historyError}
          </div>
        )}

        {!historyError && (!historyLoading || history.length > 0) && (
          <>
            {viewMode === "list" ? (
              <DocumentsListView
                groups={groups}
                expanded={expanded}
                onToggleExpand={toggleExpand}
                manageMode={manageMode}
                selectedProjects={selectedProjects}
                selectedDocs={selectedDocs}
                onToggleSelectProject={toggleSelectProject}
                onToggleSelectDoc={toggleSelectDoc}
                onProjectContextMenu={openProjectMenu}
                onDocContextMenu={openDocMenu}
                onCreateProject={() => setPrompt({ kind: "create-project" })}
              />
            ) : (
              <DocumentsIconView
                groups={groups}
                activeFolder={activeFolder}
                onOpenFolder={setActiveFolder}
                onBack={() => setActiveFolder(null)}
                manageMode={manageMode}
                selectedProjects={selectedProjects}
                selectedDocs={selectedDocs}
                onToggleSelectProject={toggleSelectProject}
                onToggleSelectDoc={toggleSelectDoc}
                onProjectContextMenu={openProjectMenu}
                onDocContextMenu={openDocMenu}
                onCreateProject={() => setPrompt({ kind: "create-project" })}
              />
            )}
          </>
        )}
      </div>

      <ProjectContextMenu
        state={contextMenu?.kind === "project" ? contextMenu : null}
        onClose={() => setContextMenu(null)}
        onRename={(project) => setPrompt({ kind: "rename-project", project })}
        onDelete={(project) => setConfirm({ kind: "delete-project", project })}
      />
      <DocumentContextMenu
        state={contextMenu?.kind === "document" ? contextMenu : null}
        projectNames={allProjectNames}
        onClose={() => setContextMenu(null)}
        onRename={(doc) => setPrompt({ kind: "rename-document", doc })}
        onDelete={(doc) => setConfirm({ kind: "delete-document", doc })}
        onMove={handleMoveDocument}
      />

      <PromptModal
        open={prompt !== null}
        title={
          prompt?.kind === "create-project"
            ? "Create project"
            : prompt?.kind === "rename-project"
              ? "Rename project"
              : "Rename document"
        }
        label={prompt?.kind === "rename-document" ? "Title" : "Project name"}
        initialValue={
          prompt?.kind === "rename-project"
            ? prompt.project.name
            : prompt?.kind === "rename-document"
              ? prompt.doc.title
              : ""
        }
        placeholder={prompt?.kind === "rename-document" ? undefined : "e.g. Thesis drafts"}
        confirmLabel={prompt?.kind === "create-project" ? "Create" : "Save"}
        onClose={() => setPrompt(null)}
        onSubmit={(value) => {
          if (!prompt) return;
          if (busy) return;
          if (prompt.kind === "create-project") void handleCreateProject(value);
          else if (prompt.kind === "rename-project") void handleRenameProject(prompt.project.name, value);
          else void handleRenameDocument(prompt.doc, value);
        }}
      />

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm?.kind === "delete-project"
            ? `Delete "${confirm.project.name}"?`
            : confirm?.kind === "bulk-delete"
              ? `Delete ${selectionCount} selected item${selectionCount === 1 ? "" : "s"}?`
              : "Delete this document?"
        }
        description={
          confirm?.kind === "delete-project"
            ? confirm.project.docs.length > 0
              ? `${confirm.project.docs.length} document${confirm.project.docs.length === 1 ? "" : "s"} will be moved to Default. They won't be deleted.`
              : "This project has no documents."
            : confirm?.kind === "bulk-delete"
              ? "Selected documents move to My Trash. Selected projects are deleted and their documents move to Default."
              : "This moves the document to My Trash. You can restore it anytime."
        }
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.kind === "delete-project") void handleDeleteProject(confirm.project);
          else if (confirm.kind === "delete-document") handleDeleteDocument(confirm.doc);
          else handleBulkDelete();
        }}
      />
    </div>
  );
}
