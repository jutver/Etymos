import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChartBar,
  FolderSimple,
  LockSimple,
  MagnifyingGlass,
  Sparkle,
  Table as TableIcon,
  Trash,
} from "@phosphor-icons/react";
import { useAppStore, historyRetentionLabel } from "../../lib/store";
import { formatDate } from "../../lib/format";
import { StatusPill } from "../../components/Severity";
import { Button } from "../../components/ui/Button";
import { ContextMenu } from "../../components/ui/ContextMenu";
import { cn } from "../../lib/cn";
import type { DocStatus } from "../../lib/types";

const RETENTION_DAYS = { free: 7, student: 365, professional: 365 };
const TODAY = new Date("2026-07-05T23:59:59");

const statusOrder: DocStatus[] = ["clean", "low", "moderate", "high"];
const statusBarColor: Record<DocStatus, string> = {
  clean: "bg-success",
  low: "bg-severity-low",
  moderate: "bg-severity-moderate",
  high: "bg-severity-high",
};

export default function HistoryPage() {
  const navigate = useNavigate();
  const plan = useAppStore((s) => s.plan);
  const history = useAppStore((s) => s.history);
  const projects = useAppStore((s) => s.projects);
  const moveHistoryEntry = useAppStore((s) => s.moveHistoryEntry);
  const moveToTrash = useAppStore((s) => s.moveToTrash);
  const pushToast = useAppStore((s) => s.pushToast);
  const [view, setView] = useState<"documents" | "stats">("documents");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [query, setQuery] = useState("");

  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  const retentionDays = RETENTION_DAYS[plan];
  const { visible, expiredCount } = useMemo(() => {
    const cutoff = new Date(TODAY);
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const visible = history.filter((h) => new Date(h.date) >= cutoff);
    return { visible, expiredCount: history.length - visible.length };
  }, [history, retentionDays]);

  const filtered = visible.filter((h) => {
    const matchesProject = projectFilter === "all" || h.project === projectFilter;
    const matchesQuery = h.title.toLowerCase().includes(query.toLowerCase());
    return matchesProject && matchesQuery;
  });

  const stats = useMemo(() => {
    const total = history.length;
    const avg = total ? Math.round(history.reduce((s, h) => s + h.similarityScore, 0) / total) : 0;
    const aiFlaggedCount = history.filter((h) => h.aiFlagged).length;
    const counts = statusOrder.map((s) => ({
      status: s,
      count: history.filter((h) => h.status === s).length,
    }));
    return { total, avg, aiFlaggedCount, counts };
  }, [history]);

  function openMenu(e: React.MouseEvent, id: string) {
    e.preventDefault();
    setMenu({ id, x: e.clientX, y: e.clientY });
  }

  function closeMenu() {
    setMenu(null);
  }

  const menuEntry = menu ? history.find((h) => h.id === menu.id) : null;

  return (
    <div className="mx-auto max-w-7xl px-5 py-10 sm:px-8">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-h1 font-bold tracking-tight text-navy-900">History</h1>
          <p className="mt-1.5 text-sm text-ink-500">
            {plan === "free"
              ? `Free plan keeps checks for ${historyRetentionLabel(plan)}. Upgrade for 12-month history.`
              : `Your plan keeps checks for ${historyRetentionLabel(plan)}.`}
          </p>
        </div>

        <div className="flex gap-1 rounded-full bg-surface-muted p-1">
          <button
            onClick={() => setView("documents")}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold transition-colors",
              view === "documents" ? "bg-white text-navy-900 shadow-sm" : "text-ink-500 hover:text-ink-700",
            )}
          >
            <TableIcon size={15} /> Documents
          </button>
          <button
            onClick={() => (plan === "professional" ? setView("stats") : navigate("/paywall"))}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold transition-colors",
              view === "stats" ? "bg-white text-navy-900 shadow-sm" : "text-ink-500 hover:text-ink-700",
            )}
          >
            <ChartBar size={15} /> Statistics
            {plan !== "professional" && <LockSimple size={12} weight="fill" />}
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

            <div className="flex items-center gap-2 overflow-x-auto">
              <FolderSimple size={15} className="shrink-0 text-ink-400" />
              <button
                onClick={() => setProjectFilter("all")}
                className={cn(
                  "shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold",
                  projectFilter === "all" ? "bg-brand-100 text-brand-700" : "text-ink-500 hover:bg-surface-tint",
                )}
              >
                All projects
              </button>
              {projects.map((p) => (
                <button
                  key={p}
                  onClick={() => setProjectFilter(p)}
                  className={cn(
                    "shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold",
                    projectFilter === p ? "bg-brand-100 text-brand-700" : "text-ink-500 hover:bg-surface-tint",
                  )}
                >
                  {p}
                </button>
              ))}
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
        <div className="mt-6 grid grid-cols-1 gap-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-[var(--radius-card-lg)] border border-line bg-white p-6">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                Total documents
              </p>
              <p className="mt-2 text-3xl font-extrabold text-navy-900">{stats.total}</p>
            </div>
            <div className="rounded-[var(--radius-card-lg)] border border-line bg-white p-6">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                Average similarity
              </p>
              <p className="mt-2 text-3xl font-extrabold text-navy-900">{stats.avg}%</p>
            </div>
            <div className="rounded-[var(--radius-card-lg)] border border-line bg-white p-6">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                AI-flagged documents
              </p>
              <p className="mt-2 text-3xl font-extrabold text-navy-900">{stats.aiFlaggedCount}</p>
            </div>
          </div>

          <div className="rounded-[var(--radius-card-lg)] border border-line bg-white p-6">
            <p className="text-sm font-bold text-navy-900">Documents by similarity band</p>
            <div className="mt-5 flex flex-col gap-3">
              {stats.counts.map((c) => (
                <div key={c.status} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 text-xs font-medium capitalize text-ink-500">
                    {c.status}
                  </span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-surface-muted">
                    <div
                      className={cn("h-full rounded-full", statusBarColor[c.status])}
                      style={{ width: `${stats.total ? (c.count / stats.total) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="w-6 shrink-0 text-right text-xs font-semibold text-ink-700">
                    {c.count}
                  </span>
                </div>
              ))}
            </div>
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
