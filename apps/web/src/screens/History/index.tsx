import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MagnifyingGlass, Trash } from "@phosphor-icons/react";
import { useAppStore, historyRetentionLabel, planLabel, PROJECTS } from "../../lib/store";
import { useAuth } from "../../lib/auth";
import { formatDate } from "@etymos/shared";
import { StatusPill } from "../../components/Severity";
import { Button } from "../../components/ui/Button";
import { cn } from "@etymos/shared";

const RETENTION_DAYS = { free: 7, student: 270, professional: 365 };
const CREDIT_RETENTION_DAYS = 30;
const TODAY = new Date("2026-07-05T23:59:59");

export default function HistoryPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const plan = useAppStore((s) => s.plan);
  const credits = useAppStore((s) => s.credits);
  const history = useAppStore((s) => s.history);
  const historyLoading = useAppStore((s) => s.historyLoading);
  const historyError = useAppStore((s) => s.historyError);
  const fetchHistory = useAppStore((s) => s.fetchHistory);
  const moveToTrash = useAppStore((s) => s.moveToTrash);
  const pushToast = useAppStore((s) => s.pushToast);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!user?.id) return;
    void fetchHistory(user.id);
  }, [user?.id, fetchHistory]);

  const retentionDays = credits > 0 ? CREDIT_RETENTION_DAYS : RETENTION_DAYS[plan];
  const { visible, expiredCount } = useMemo(() => {
    const cutoff = new Date(TODAY);
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const visible = history.filter((h) => new Date(h.date) >= cutoff);
    return { visible, expiredCount: history.length - visible.length };
  }, [history, retentionDays]);

  const filtered = visible.filter((h) => h.title.toLowerCase().includes(query.toLowerCase()));

  function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    moveToTrash(id);
    pushToast({ kind: "info", title: "Moved to trash", description: "Restore it anytime from My Trash." });
  }

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
        </div>

        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs font-semibold uppercase tracking-wide text-ink-400">
              <th className="px-5 py-3 font-semibold">Document</th>
              <th className="px-5 py-3 font-semibold">Date</th>
              <th className="px-5 py-3 font-semibold">Similarity</th>
              <th className="px-5 py-3 font-semibold">Status</th>
              <th className="px-5 py-3 font-semibold">Project</th>
              <th className="px-5 py-3 font-semibold" />
            </tr>
          </thead>
          <tbody>
            {historyLoading &&
              filtered.length === 0 &&
              Array.from({ length: 3 }).map((_, i) => (
                <tr key={`skeleton-${i}`} className="border-b border-line last:border-0">
                  <td colSpan={6} className="px-5 py-4">
                    <div className="h-4 w-full animate-pulse rounded bg-surface-muted" />
                  </td>
                </tr>
              ))}

            {!historyLoading &&
              filtered.map((h) => (
                <tr
                  key={h.id}
                  onClick={() => navigate(`/report/${h.id}`)}
                  className="cursor-pointer border-b border-line last:border-0 hover:bg-surface-tint"
                >
                  <td className="max-w-xs truncate px-5 py-4 font-medium text-ink-900">
                    <span className="flex items-center gap-2">
                      {h.title}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-5 py-4 text-ink-500">{formatDate(h.date)}</td>
                  <td className="px-5 py-4 font-semibold text-ink-700">{h.similarityScore}%</td>
                  <td className="px-5 py-4">
                    <StatusPill status={h.status} />
                  </td>
                  <td className="px-5 py-4 text-ink-500">{h.project ?? PROJECTS[0]}</td>
                  <td className="px-5 py-4 text-right">
                    <button
                      onClick={(e) => handleDelete(e, h.id)}
                      aria-label="Move to trash"
                      className={cn(
                        "inline-flex size-8 items-center justify-center rounded-full text-ink-400 hover:bg-severity-high-bg hover:text-severity-high",
                      )}
                    >
                      <Trash size={15} />
                    </button>
                  </td>
                </tr>
              ))}

            {!historyLoading && !historyError && filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-12 text-center text-sm text-ink-400">
                  {history.length === 0 ? "No documents yet." : "No documents match your search."}
                </td>
              </tr>
            )}

            {historyError && (
              <tr>
                <td colSpan={6} className="px-5 py-12 text-center text-sm text-severity-high">
                  {historyError}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <p className="border-t border-line px-5 py-3 text-xs text-ink-400 sm:hidden">
          Tip: tap the trash icon to delete a document.
        </p>
      </div>
    </div>
  );
}
