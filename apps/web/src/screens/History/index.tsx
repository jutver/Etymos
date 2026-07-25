import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CaretRight, ClockCounterClockwise, MagnifyingGlass, Trash } from "@phosphor-icons/react";
import { useAppStore, historyRetentionLabel, planLabel, PROJECTS } from "../../lib/store";
import { useAuth } from "../../lib/auth";
import { formatDate } from "@etymos/shared";
import { StatusPill } from "../../components/Severity";
import { Button } from "../../components/ui/Button";
import { cn } from "@etymos/shared";
import { CheckStatePill } from "../Documents/CheckStatePill";
import { analyzingStateFor } from "../../lib/documentsQueries";
import type { HistoryEntryWithCheck } from "../../lib/documentsQueries";

const RETENTION_DAYS = { free: 7, student: 270, professional: 365 };
const CREDIT_RETENTION_DAYS = 30;
const TODAY = new Date("2026-07-05T23:59:59");

/** One source file's check history: every check that shares the same
 * `fileName` (or `title`, for pasted-text checks with no file), newest first. */
interface FileGroup {
  key: string;
  latest: HistoryEntryWithCheck;
  versions: HistoryEntryWithCheck[];
}

export default function HistoryPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const plan = useAppStore((s) => s.plan);
  const standardCredits = useAppStore((s) => s.standardCredits);
  const premiumCredits = useAppStore((s) => s.premiumCredits);
  const credits = standardCredits + premiumCredits;
  const history = useAppStore((s) => s.history);
  const historyLoading = useAppStore((s) => s.historyLoading);
  const historyError = useAppStore((s) => s.historyError);
  const fetchHistory = useAppStore((s) => s.fetchHistory);
  const reconcileCheckingDocuments = useAppStore((s) => s.reconcileCheckingDocuments);
  const moveToTrash = useAppStore((s) => s.moveToTrash);
  const pushToast = useAppStore((s) => s.pushToast);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!user?.id) return;
    void fetchHistory(user.id);
  }, [user?.id, fetchHistory]);

  // While anything is still checking, keep asking the backend how it's going so
  // the row settles without the user having to navigate away and back.
  const hasCheckingDocs = history.some((h) => h.checkState === "checking");
  useEffect(() => {
    if (!hasCheckingDocs) return;
    const timer = window.setInterval(() => void reconcileCheckingDocuments(), 5000);
    return () => window.clearInterval(timer);
  }, [hasCheckingDocs, reconcileCheckingDocuments]);

  const retentionDays = credits > 0 ? CREDIT_RETENTION_DAYS : RETENTION_DAYS[plan];
  const { visible, expiredCount } = useMemo(() => {
    const cutoff = new Date(TODAY);
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const visible = history.filter((h) => new Date(h.date) >= cutoff);
    return { visible, expiredCount: history.length - visible.length };
  }, [history, retentionDays]);

  const filtered = visible.filter((h) => h.title.toLowerCase().includes(query.toLowerCase()));

  /** Group checks by source file (falling back to title for pasted-text
   * checks, which have no file) — this is check-history grouping, not exact
   * content dedup. Groups sort by most-recent check descending; versions
   * within a group sort newest-first. */
  const groups = useMemo<FileGroup[]>(() => {
    const byKey = new Map<string, HistoryEntryWithCheck[]>();
    for (const h of filtered) {
      const key = h.fileName?.trim() || h.title;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(h);
    }
    return [...byKey.entries()]
      .map(([key, entries]) => {
        const versions = [...entries].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
        return { key, latest: versions[0], versions };
      })
      .sort((a, b) => (a.latest.date < b.latest.date ? 1 : a.latest.date > b.latest.date ? -1 : 0));
  }, [filtered]);

  /** A check that hasn't finished has no report to show — send it back to the
   * progress view instead of an empty report. */
  function openEntry(entry: HistoryEntryWithCheck) {
    if (entry.checkState === "checking") {
      navigate("/analyzing", { state: analyzingStateFor(entry) });
      return;
    }
    navigate(`/report/${entry.id}`);
  }

  function toggleExpand(key: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    try {
      await moveToTrash(id);
      pushToast({ kind: "info", title: "Moved to trash", description: "Restore it anytime from My Trash." });
    } catch (err) {
      pushToast({
        kind: "error",
        title: "Couldn't move to trash",
        description: err instanceof Error ? err.message : "Please try again.",
      });
    }
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

        {historyLoading && filtered.length === 0 && (
          <div className="divide-y divide-line">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={`skeleton-${i}`} className="px-5 py-4">
                <div className="h-4 w-full animate-pulse motion-reduce:animate-none rounded bg-surface-muted" />
              </div>
            ))}
          </div>
        )}

        {!historyLoading && (
          <div className="divide-y divide-line">
            {groups.map((group) => {
              const isOpen = expanded.has(group.key);
              const hasVersions = group.versions.length > 1;
              return (
                <div key={group.key}>
                  <div
                    onClick={() => (hasVersions ? toggleExpand(group.key) : openEntry(group.latest))}
                    className="flex cursor-pointer items-center gap-3 px-5 py-4 transition-colors hover:bg-surface-tint"
                  >
                    {hasVersions ? (
                      <CaretRight
                        size={13}
                        weight="bold"
                        className={cn("shrink-0 text-ink-400 transition-transform", isOpen && "rotate-90")}
                      />
                    ) : (
                      <span className="inline-block size-[13px] shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-medium text-ink-900">{group.latest.title}</span>
                    {hasVersions && (
                      <span className="hidden shrink-0 items-center gap-1 rounded-full bg-brand-100/60 px-2 py-0.5 text-xs font-medium text-brand-600 sm:flex">
                        <ClockCounterClockwise size={12} />
                        {group.versions.length} checks
                      </span>
                    )}
                    <span className="hidden shrink-0 whitespace-nowrap text-sm text-ink-500 sm:inline">
                      {formatDate(group.latest.date)}
                    </span>
                    <span className="hidden w-14 shrink-0 text-right text-sm font-semibold text-ink-700 sm:inline">
                      {group.latest.checkState === "completed" ? `${group.latest.similarityScore}%` : "—"}
                    </span>
                    <span className="shrink-0">
                      {group.latest.checkState === "completed" ? (
                        <StatusPill status={group.latest.status} />
                      ) : (
                        <CheckStatePill state={group.latest.checkState} />
                      )}
                    </span>
                    <span className="hidden shrink-0 text-sm text-ink-500 sm:inline">
                      {group.latest.project ?? PROJECTS[0]}
                    </span>
                    {!hasVersions && (
                      <button
                        onClick={(e) => handleDelete(e, group.latest.id)}
                        aria-label="Move to trash"
                        className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-ink-400 hover:bg-severity-high-bg hover:text-severity-high"
                      >
                        <Trash size={15} />
                      </button>
                    )}
                  </div>

                  {hasVersions && isOpen && (
                    <div className="border-t border-line bg-surface-tint/50">
                      {group.versions.map((v, i) => (
                        <div
                          key={v.id}
                          onClick={() => openEntry(v)}
                          className="flex cursor-pointer items-center gap-3 border-t border-line/60 py-3 pl-11 pr-5 text-left transition-colors first:border-t-0 hover:bg-white"
                        >
                          <span className="w-16 shrink-0 text-xs font-medium text-ink-400">
                            {i === 0 ? "Latest" : `v${group.versions.length - i}`}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm text-ink-700">
                            {formatDate(v.date)}
                          </span>
                          <span className="hidden shrink-0 text-xs font-semibold text-ink-700 sm:inline">
                            {v.checkState === "completed" ? `${v.similarityScore}%` : "—"}
                          </span>
                          <span className="shrink-0">
                            {v.checkState === "completed" ? (
                              <StatusPill status={v.status} />
                            ) : (
                              <CheckStatePill state={v.checkState} />
                            )}
                          </span>
                          <button
                            onClick={(e) => handleDelete(e, v.id)}
                            aria-label="Move to trash"
                            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-ink-400 hover:bg-severity-high-bg hover:text-severity-high"
                          >
                            <Trash size={15} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {!historyError && groups.length === 0 && (
              <p className="px-5 py-12 text-center text-sm text-ink-400">
                {history.length === 0 ? "No documents yet." : "No documents match your search."}
              </p>
            )}

            {historyError && (
              <p className="px-5 py-12 text-center text-sm text-severity-high">{historyError}</p>
            )}
          </div>
        )}

        <p className="border-t border-line px-5 py-3 text-xs text-ink-400 sm:hidden">
          Tip: tap a file with multiple checks to see its version history.
        </p>
      </div>
    </div>
  );
}
