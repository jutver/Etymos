import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Check,
  CaretDown,
  CheckCircle,
  FolderSimple,
  MagnifyingGlass,
  Plus,
  Sparkle,
  SquaresFour,
  Table as TableIcon,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useAppStore, historyRetentionLabel, planLabel } from "../../lib/store";
import { formatDate } from "../../lib/format";
import { StatusPill } from "../../components/Severity";
import { Button } from "../../components/ui/Button";
import { ContextMenu } from "../../components/ui/ContextMenu";
import { cn } from "../../lib/cn";

const RETENTION_DAYS = { free: 7, student: 270, professional: 365 };
const CREDIT_RETENTION_DAYS = 30;
const TODAY = new Date("2026-07-05T23:59:59");
const UNASSIGNED = "__unassigned__";

export default function HistoryPage() {
  const navigate = useNavigate();
  const plan = useAppStore((s) => s.plan);
  const credits = useAppStore((s) => s.credits);
  const history = useAppStore((s) => s.history);
  const projects = useAppStore((s) => s.projects);
  const addProject = useAppStore((s) => s.addProject);
  const deleteProjects = useAppStore((s) => s.deleteProjects);
  const moveHistoryEntry = useAppStore((s) => s.moveHistoryEntry);
  const moveToTrash = useAppStore((s) => s.moveToTrash);
  const pushToast = useAppStore((s) => s.pushToast);
  const [view, setView] = useState<"documents" | "projects">("documents");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [projectFilterOpen, setProjectFilterOpen] = useState(false);
  const projectFilterRef = useRef<HTMLDivElement>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [manageMode, setManageMode] = useState(false);
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());

  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!projectFilterOpen) return;
    const onClick = (e: MouseEvent) => {
      if (projectFilterRef.current && !projectFilterRef.current.contains(e.target as Node)) {
        setProjectFilterOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [projectFilterOpen]);

  const retentionDays = credits > 0 ? CREDIT_RETENTION_DAYS : RETENTION_DAYS[plan];
  const { visible, expiredCount } = useMemo(() => {
    const cutoff = new Date(TODAY);
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const visible = history.filter((h) => new Date(h.date) >= cutoff);
    return { visible, expiredCount: history.length - visible.length };
  }, [history, retentionDays]);

  const filtered = visible.filter((h) => {
    const matchesProject =
      projectFilter === "all"
        ? true
        : projectFilter === UNASSIGNED
          ? !h.project
          : h.project === projectFilter;
    const matchesQuery = h.title.toLowerCase().includes(query.toLowerCase());
    return matchesProject && matchesQuery;
  });

  const projectCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of projects) counts.set(p, 0);
    let unassigned = 0;
    for (const h of visible) {
      if (h.project) {
        counts.set(h.project, (counts.get(h.project) ?? 0) + 1);
      } else {
        unassigned += 1;
      }
    }
    return { counts, unassigned };
  }, [visible, projects]);

  const projectFilterLabel =
    projectFilter === "all" ? "All projects" : projectFilter === UNASSIGNED ? "No project" : projectFilter;

  function openMenu(e: React.MouseEvent, id: string) {
    e.preventDefault();
    setMenu({ id, x: e.clientX, y: e.clientY });
  }

  function closeMenu() {
    setMenu(null);
  }

  function openProject(name: string) {
    setProjectFilter(name);
    setView("documents");
  }

  function confirmCreateProject() {
    const name = newProjectName.trim();
    if (!name) return;
    addProject(name);
    setNewProjectName("");
    setCreatingProject(false);
  }

  function cancelCreateProject() {
    setNewProjectName("");
    setCreatingProject(false);
  }

  function toggleManageMode() {
    setManageMode((v) => !v);
    setSelectedProjects(new Set());
    setCreatingProject(false);
  }

  function toggleProjectSelected(name: string) {
    setSelectedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function deleteSelectedProjects() {
    const names = [...selectedProjects];
    if (names.length === 0) return;
    deleteProjects(names);
    if (names.includes(projectFilter)) setProjectFilter("all");
    pushToast({
      kind: "info",
      title: `${names.length} project${names.length === 1 ? "" : "s"} deleted`,
      description: "Documents inside were kept and moved to No project.",
    });
    setSelectedProjects(new Set());
    setManageMode(false);
  }

  const menuEntry = menu ? history.find((h) => h.id === menu.id) : null;

  return (
    <div className="mx-auto max-w-7xl px-5 py-10 sm:px-8">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-h1 font-bold tracking-tight text-navy-900">History</h1>
          <p className="mt-1.5 text-sm text-ink-500">
            {credits > 0
              ? `Credit-pack checks are kept for ${historyRetentionLabel(plan, true)}.`
              : plan === "free"
                ? `Free plan keeps checks for ${historyRetentionLabel(plan)}. Upgrade for extended history.`
                : `Your ${planLabel(plan)} plan keeps checks for ${historyRetentionLabel(plan)}.`}
          </p>
        </div>

        <div className="flex gap-1 rounded-full bg-surface-muted p-1.5">
          <button
            onClick={() => setView("documents")}
            className={cn(
              "flex min-w-[8.25rem] items-center justify-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold transition-colors",
              view === "documents" ? "bg-white text-navy-900 shadow-sm" : "text-ink-500 hover:text-ink-700",
            )}
          >
            <TableIcon size={15} /> Documents
          </button>
          <button
            onClick={() => setView("projects")}
            className={cn(
              "flex min-w-[8.25rem] items-center justify-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold transition-colors",
              view === "projects" ? "bg-white text-navy-900 shadow-sm" : "text-ink-500 hover:text-ink-700",
            )}
          >
            <SquaresFour size={15} /> Projects
          </button>
        </div>
      </div>

      {expiredCount > 0 && (
        <div className="mt-5 flex items-center justify-between rounded-[var(--radius-card)] border border-severity-moderate-line bg-severity-moderate-bg px-4 py-3 text-sm text-severity-moderate">
          <span>
            {expiredCount} older check{expiredCount === 1 ? "" : "s"} removed after the 7-day Free
            retention window.
          </span>
          <Button as="link" to="/pricing" size="sm" variant="outline">
            Keep history for 12 months
          </Button>
        </div>
      )}

      {view === "documents" ? (
        <div className="mt-6 rounded-[var(--radius-card-lg)] border border-line bg-white">
          <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:w-72">
              <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-300" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search documents..."
                className="w-full rounded-full border border-line bg-surface-tint py-2 pl-9 pr-4 text-sm placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
              />
            </div>

            <div className="relative shrink-0" ref={projectFilterRef}>
              <button
                onClick={() => setProjectFilterOpen((v) => !v)}
                className="flex items-center gap-2 rounded-[var(--radius-control)] border border-line bg-white px-3.5 py-2 text-xs font-semibold text-ink-700 hover:border-brand-300"
              >
                <FolderSimple size={15} className="text-ink-400" />
                {projectFilterLabel}
                <CaretDown size={13} className={cn("transition-transform", projectFilterOpen && "rotate-180")} />
              </button>
              {projectFilterOpen && (
                <div className="absolute right-0 top-[calc(100%+6px)] z-20 w-56 rounded-[var(--radius-card)] border border-line bg-white p-1.5 shadow-[var(--shadow-pop)]">
                  <button
                    onClick={() => {
                      setProjectFilter("all");
                      setProjectFilterOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium",
                      projectFilter === "all" ? "bg-brand-100 text-brand-700" : "text-ink-700 hover:bg-surface-tint",
                    )}
                  >
                    {projectFilter === "all" && <CheckCircle size={14} weight="fill" />}
                    All projects
                  </button>
                  {projects.map((p) => (
                    <button
                      key={p}
                      onClick={() => {
                        setProjectFilter(p);
                        setProjectFilterOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium",
                        projectFilter === p ? "bg-brand-100 text-brand-700" : "text-ink-700 hover:bg-surface-tint",
                      )}
                    >
                      {projectFilter === p && <CheckCircle size={14} weight="fill" />}
                      {p}
                    </button>
                  ))}
                  {projectCounts.unassigned > 0 && (
                    <button
                      onClick={() => {
                        setProjectFilter(UNASSIGNED);
                        setProjectFilterOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium",
                        projectFilter === UNASSIGNED
                          ? "bg-brand-100 text-brand-700"
                          : "text-ink-700 hover:bg-surface-tint",
                      )}
                    >
                      {projectFilter === UNASSIGNED && <CheckCircle size={14} weight="fill" />}
                      No project
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs font-semibold uppercase tracking-wide text-ink-400">
                <th className="px-5 py-3 font-semibold">Document</th>
                <th className="px-5 py-3 font-semibold">Date</th>
                <th className="px-5 py-3 font-semibold">Similarity</th>
                <th className="px-5 py-3 font-semibold">Status</th>
                <th className="px-5 py-3 font-semibold">Project</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((h) => (
                <tr
                  key={h.id}
                  onClick={() => navigate(`/report/${h.id}`)}
                  onContextMenu={(e) => openMenu(e, h.id)}
                  className="cursor-pointer border-b border-line last:border-0 hover:bg-surface-tint"
                >
                  <td className="max-w-xs truncate px-5 py-4 font-medium text-ink-900">
                    <span className="flex items-center gap-2">
                      {h.title}
                      {h.aiFlagged && <Sparkle size={13} weight="fill" className="shrink-0 text-ai-flag" />}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-5 py-4 text-ink-500">{formatDate(h.date)}</td>
                  <td className="px-5 py-4 font-semibold text-ink-700">{h.similarityScore}%</td>
                  <td className="px-5 py-4">
                    <StatusPill status={h.status} />
                  </td>
                  <td className="px-5 py-4 text-ink-500">{h.project ?? "—"}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-12 text-center text-sm text-ink-400">
                    No documents match your search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="border-t border-line px-5 py-3 text-xs text-ink-400 sm:hidden">
            Tip: press and hold a row for more options.
          </p>
        </div>
      ) : (
        <div className="mt-6">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
              {manageMode
                ? `${selectedProjects.size} selected`
                : `${projects.length} project${projects.length === 1 ? "" : "s"}`}
            </p>
            {manageMode ? (
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={toggleManageMode}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={selectedProjects.size === 0}
                  iconLeft={<Trash size={14} />}
                  onClick={deleteSelectedProjects}
                >
                  Delete{selectedProjects.size > 0 ? ` (${selectedProjects.size})` : ""}
                </Button>
              </div>
            ) : (
              projects.length > 0 && (
                <Button size="sm" variant="outline" onClick={toggleManageMode}>
                  Manage projects
                </Button>
              )
            )}
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {!manageMode &&
              (creatingProject ? (
                <div className="flex aspect-square flex-col items-center justify-center gap-3 rounded-[var(--radius-card-lg)] border-2 border-brand-300 bg-white p-5 text-center">
                  <div className="flex size-14 items-center justify-center rounded-2xl bg-brand-100 text-brand-600">
                    <FolderSimple size={26} weight="fill" />
                  </div>
                  <input
                    autoFocus
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") confirmCreateProject();
                      if (e.key === "Escape") cancelCreateProject();
                    }}
                    placeholder="Project name"
                    className="w-full rounded-lg border border-line bg-surface-tint px-2 py-1.5 text-center text-sm placeholder:text-ink-300 focus:border-brand-400 focus:outline-none"
                  />
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={confirmCreateProject}
                      disabled={!newProjectName.trim()}
                      aria-label="Create project"
                      className="flex size-7 items-center justify-center rounded-full bg-brand-500 text-white hover:brightness-105 disabled:opacity-40"
                    >
                      <Check size={14} weight="bold" />
                    </button>
                    <button
                      onClick={cancelCreateProject}
                      aria-label="Cancel"
                      className="flex size-7 items-center justify-center rounded-full text-ink-400 hover:bg-surface-tint hover:text-ink-700"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setCreatingProject(true)}
                  className="group flex aspect-square flex-col items-center justify-center gap-3 rounded-[var(--radius-card-lg)] border border-dashed border-line bg-white p-5 text-center transition-colors hover:border-brand-300 hover:bg-surface-tint"
                >
                  <div className="flex size-14 items-center justify-center rounded-2xl bg-surface-muted text-brand-600 transition-colors group-hover:bg-brand-100">
                    <Plus size={26} weight="bold" />
                  </div>
                  <p className="text-sm font-bold text-ink-900">New project</p>
                </button>
              ))}

            {projects.map((p) => {
              const selected = selectedProjects.has(p);
              return (
                <button
                  key={p}
                  onClick={() => (manageMode ? toggleProjectSelected(p) : openProject(p))}
                  className={cn(
                    "group relative flex aspect-square flex-col items-center justify-center gap-3 rounded-[var(--radius-card-lg)] border p-5 text-center transition-colors",
                    selected
                      ? "border-brand-500 bg-brand-100/30"
                      : "border-line bg-white hover:border-brand-300 hover:bg-surface-tint",
                  )}
                >
                  {manageMode && (
                    <span
                      className={cn(
                        "absolute right-3 top-3 flex size-5 items-center justify-center rounded-full border-2",
                        selected ? "border-brand-500 bg-brand-500 text-white" : "border-line bg-white",
                      )}
                    >
                      {selected && <Check size={12} weight="bold" />}
                    </span>
                  )}
                  <div
                    className={cn(
                      "flex size-14 items-center justify-center rounded-2xl transition-colors",
                      selected
                        ? "bg-brand-100 text-brand-600"
                        : "bg-surface-muted text-brand-600 group-hover:bg-brand-100",
                    )}
                  >
                    <FolderSimple size={26} weight="fill" />
                  </div>
                  <div>
                    <p className="truncate text-sm font-bold text-ink-900">{p}</p>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {projectCounts.counts.get(p) ?? 0} document
                      {(projectCounts.counts.get(p) ?? 0) === 1 ? "" : "s"}
                    </p>
                  </div>
                </button>
              );
            })}

            {projectCounts.unassigned > 0 && (
              <button
                onClick={() => !manageMode && openProject(UNASSIGNED)}
                disabled={manageMode}
                className={cn(
                  "group flex aspect-square flex-col items-center justify-center gap-3 rounded-[var(--radius-card-lg)] border border-dashed border-line bg-white p-5 text-center transition-colors",
                  manageMode ? "cursor-not-allowed opacity-50" : "hover:border-brand-300 hover:bg-surface-tint",
                )}
              >
                <div className="flex size-14 items-center justify-center rounded-2xl bg-surface-muted text-ink-400 transition-colors group-hover:bg-brand-100 group-hover:text-brand-600">
                  <FolderSimple size={26} />
                </div>
                <div>
                  <p className="text-sm font-bold text-ink-900">No project</p>
                  <p className="mt-0.5 text-xs text-ink-500">
                    {projectCounts.unassigned} document{projectCounts.unassigned === 1 ? "" : "s"}
                  </p>
                </div>
              </button>
            )}
          </div>
        </div>
      )}

      <ContextMenu open={menu !== null} onClose={closeMenu} position={menu ?? { x: 0, y: 0 }}>
        <p className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink-400">
          Move to project
        </p>
        {projects
          .filter((p) => p !== menuEntry?.project)
          .map((p) => (
            <button
              key={p}
              onClick={() => {
                if (menu) moveHistoryEntry(menu.id, p);
                closeMenu();
              }}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-ink-700 hover:bg-surface-tint"
            >
              <FolderSimple size={15} />
              {p}
            </button>
          ))}
        <div className="my-1 h-px bg-line" />
        <button
          onClick={() => {
            if (menu) {
              moveToTrash(menu.id);
              pushToast({ kind: "info", title: "Moved to trash", description: "Restore it anytime from My Trash." });
            }
            closeMenu();
          }}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-severity-high hover:bg-severity-high-bg"
        >
          <Trash size={15} />
          Delete
        </button>
      </ContextMenu>
    </div>
  );
}
