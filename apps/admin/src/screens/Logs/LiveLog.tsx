// Live tab: the backend's log as it happens, polled every two seconds from
// the API's in-memory buffer (the last few thousand lines since it started).
// Clicking a check, request or user tag narrows the view to it.
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowDown, DownloadSimple, MagnifyingGlass, Pause, Play, Trash, X } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { fetchLiveLog, LOG_LEVELS, type LiveLogFilters, type LogLevel, type LogRow } from "../../lib/opsApi";
import { friendlyError } from "../../lib/errors";
import { t, tn, tr } from "../../lib/i18n";
import { download, levelTone, logTime, rowAsText, shortJob, TONE_CLASS } from "./format";

const POLL_MS = 2000;
/** Rows kept on screen; older ones scroll away. */
const MAX_ROWS = 3000;

const LEVEL_LABELS: Record<LogLevel, string> = {
  DEBUG: tr("Everything"),
  INFO: tr("Info and up"),
  WARNING: tr("Warnings and errors"),
  ERROR: tr("Errors only"),
};

const LEVEL_BADGE: Record<string, string> = {
  DEBUG: "text-white/40",
  INFO: "text-sky-300",
  WARNING: "text-amber-300",
  ERROR: "text-red-400",
  CRITICAL: "text-red-400",
};

const EMPTY_FILTERS: LiveLogFilters = { level: "DEBUG", q: "", job: "", request: "", userId: "" };

const control =
  "flex h-8 cursor-pointer items-center gap-1.5 rounded-control border border-border bg-surface px-2.5 text-caption font-medium text-fg-muted transition hover:bg-surface-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-50";

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function FilterChip({ label, value, onClear }: { label: string; value: string; onClear: () => void }) {
  return (
    <span className="inline-flex h-8 items-center gap-1.5 rounded-control border border-accent/40 bg-accent-bg px-2.5 text-caption text-accent">
      <span className="text-fg-muted">{label}</span>
      <span className="font-mono">{value}</span>
      <button type="button" onClick={onClear} aria-label={t("Remove filter")} className="cursor-pointer hover:text-fg">
        <X size={12} weight="bold" />
      </button>
    </span>
  );
}

function Row({
  row,
  open,
  onToggle,
  onFilter,
}: {
  row: LogRow;
  open: boolean;
  onToggle: () => void;
  onFilter: (key: "job" | "request" | "userId", value: string) => void;
}) {
  const tag = "cursor-pointer rounded px-1 hover:bg-white/10";
  return (
    <div className={cn("group border-b border-white/5 px-3 py-0.5 hover:bg-white/[0.03]", row.exc && "cursor-pointer")}>
      <div className="flex gap-2" onClick={row.exc ? onToggle : undefined}>
        <span className="shrink-0 tabular-nums text-white/35">{logTime(row.ts)}</span>
        <span className={cn("w-12 shrink-0 font-semibold", LEVEL_BADGE[row.level] ?? "text-white/70")}>
          {row.level === "WARNING" ? "WARN" : row.level === "CRITICAL" ? "CRIT" : row.level}
        </span>
        <span className="min-w-0 flex-1 break-words">
          {row.job && (
            <button
              type="button"
              className={cn(tag, "mr-1 text-violet-300")}
              title={t("Show only this check")}
              onClick={(e) => {
                e.stopPropagation();
                onFilter("job", row.job!);
              }}
            >
              [{shortJob(row.job)}]
            </button>
          )}
          {!row.job && row.request && (
            <button
              type="button"
              className={cn(tag, "mr-1 text-teal-300")}
              title={t("Show only this request")}
              onClick={(e) => {
                e.stopPropagation();
                onFilter("request", row.request!);
              }}
            >
              [r:{row.request}]
            </button>
          )}
          {row.user && (
            <button
              type="button"
              className={cn(tag, "mr-1 text-white/50")}
              title={t("Show only this user")}
              onClick={(e) => {
                e.stopPropagation();
                onFilter("userId", row.user!);
              }}
            >
              u:{row.user.slice(0, 8)}
            </button>
          )}
          <span className="mr-1.5 text-white/40">{row.logger}:</span>
          <span className={cn("whitespace-pre-wrap", TONE_CLASS[levelTone(row.level)])}>{row.message}</span>
          {row.exc && !open && <span className="ml-2 text-red-300/70">▸ {t("traceback")}</span>}
        </span>
      </div>
      {row.exc && open && (
        <pre className="mb-1 ml-[8.5rem] mt-1 overflow-x-auto whitespace-pre rounded bg-black/30 p-2 text-red-200/90">
          {row.exc}
        </pre>
      )}
    </div>
  );
}

export default function LiveLogPage() {
  // ?job=, ?request= and ?user= (links from the Server tab and elsewhere) pre-set a filter.
  const [params] = useSearchParams();
  const [filters, setFilters] = useState<LiveLogFilters>(() => ({
    ...EMPTY_FILTERS,
    job: params.get("job") ?? "",
    request: params.get("request") ?? "",
    userId: params.get("user") ?? "",
  }));
  const [search, setSearch] = useState("");
  const q = useDebounced(search, 400);
  const active: LiveLogFilters = { ...filters, q };
  const filterKey = JSON.stringify(active);

  const [rows, setRows] = useState<LogRow[]>([]);
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ level: string; pid: number; capacity: number } | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());

  const afterRef = useRef(0);
  const pidRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const poll = useCallback(
    async (signal: { cancelled: boolean }) => {
      try {
        const page = await fetchLiveLog(afterRef.current, JSON.parse(filterKey) as LiveLogFilters);
        if (signal.cancelled) return;
        setError(null);
        setMeta({ level: page.level, pid: page.pid, capacity: page.capacity });
        // A restarted API numbers its lines from 1 again.
        if (pidRef.current !== null && page.pid !== pidRef.current) {
          pidRef.current = page.pid;
          afterRef.current = 0;
          setNotice(t("The API restarted (new process {{pid}}). Lines from before the restart are in Log files.", { pid: page.pid }));
          setRows([]);
          return;
        }
        pidRef.current = page.pid;
        if (afterRef.current === 0 && page.truncated) {
          setNotice(t("Showing the newest {{count}} matching lines.", { count: page.rows.length }));
        } else if (afterRef.current > 0 && page.truncated) {
          setNotice(t("Lines came in faster than the screen could show; some were skipped. Narrow the filters to see them all."));
        }
        afterRef.current = Math.max(afterRef.current, page.last_seq);
        if (page.rows.length) setRows((prev) => [...prev, ...page.rows].slice(-MAX_ROWS));
      } catch (err) {
        if (!signal.cancelled) setError(friendlyError(err));
      }
    },
    [filterKey],
  );

  // New filters: start over from the newest matching lines.
  useEffect(() => {
    afterRef.current = 0;
    setRows([]);
    setOpen(new Set());
    setNotice(null);
  }, [filterKey]);

  useEffect(() => {
    if (paused) return;
    const signal = { cancelled: false };
    let timer = 0;
    const loop = async () => {
      await poll(signal);
      if (!signal.cancelled) timer = window.setTimeout(loop, POLL_MS);
    };
    void loop();
    return () => {
      signal.cancelled = true;
      window.clearTimeout(timer);
    };
  }, [poll, paused]);

  useEffect(() => {
    const el = scrollRef.current;
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [rows, follow]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== follow) setFollow(atBottom);
  }

  function setFilter(key: "job" | "request" | "userId", value: string) {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  const hasFilters = filters.job || filters.request || filters.userId || search || filters.level !== "DEBUG";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative">
          <MagnifyingGlass size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("Search the log")}
            aria-label={t("Search the log")}
            className="h-8 w-56 rounded-control border border-border bg-surface pl-8 pr-2 text-caption text-fg outline-none focus:border-accent"
          />
        </label>
        <select
          value={filters.level}
          onChange={(e) => setFilters((f) => ({ ...f, level: e.target.value as LogLevel }))}
          aria-label={t("Lowest level shown")}
          className="h-8 cursor-pointer rounded-control border border-border bg-surface px-2 text-caption text-fg outline-none focus:border-accent"
        >
          {LOG_LEVELS.map((level) => (
            <option key={level} value={level}>
              {t(LEVEL_LABELS[level])}
            </option>
          ))}
        </select>
        {filters.job && <FilterChip label={t("Check")} value={shortJob(filters.job)} onClear={() => setFilter("job", "")} />}
        {filters.request && (
          <FilterChip label={t("Request")} value={filters.request} onClear={() => setFilter("request", "")} />
        )}
        {filters.userId && (
          <FilterChip label={t("User")} value={filters.userId.slice(0, 8)} onClear={() => setFilter("userId", "")} />
        )}
        {hasFilters && (
          <button
            type="button"
            className="h-8 cursor-pointer px-1 text-caption font-medium text-accent hover:underline"
            onClick={() => {
              setFilters(EMPTY_FILTERS);
              setSearch("");
            }}
          >
            {t("Clear filters")}
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          <button type="button" className={control} onClick={() => setPaused((p) => !p)}>
            {paused ? <Play size={14} weight="bold" /> : <Pause size={14} weight="bold" />}
            {paused ? t("Resume") : t("Pause")}
          </button>
          <button type="button" className={control} onClick={() => setRows([])} disabled={!rows.length}>
            <Trash size={14} weight="bold" />
            {t("Clear screen")}
          </button>
          <button
            type="button"
            className={control}
            disabled={!rows.length}
            onClick={() =>
              download(
                `etymos-api-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`,
                rows.map(rowAsText).join("\n") + "\n",
              )
            }
          >
            <DownloadSimple size={14} weight="bold" />
            {t("Download")}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-fg-muted">
        <span className="inline-flex items-center gap-1.5">
          <span
            className={cn(
              "size-2 rounded-full",
              error ? "bg-destructive" : paused ? "bg-fg-subtle" : "animate-pulse bg-success",
            )}
          />
          {error ? t("Not connected") : paused ? t("Paused") : t("Streaming")}
        </span>
        <span>{tn(rows.length, "{{count}} line", "{{count}} lines")}</span>
        {meta && (
          <>
            <span>{t("API process {{pid}}", { pid: meta.pid })}</span>
            <span>{t("Server log level: {{level}}", { level: meta.level })}</span>
            <span className="text-fg-subtle">
              {t("Keeps the last {{count}} lines in memory", { count: meta.capacity.toLocaleString() })}
            </span>
          </>
        )}
      </div>

      {error && (
        <p className="rounded-card border border-destructive/40 bg-destructive-bg px-3 py-2 text-caption text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p className="flex items-start justify-between gap-3 rounded-card border border-border bg-surface px-3 py-2 text-caption text-fg-muted">
          {notice}
          <button type="button" className="cursor-pointer text-fg-subtle hover:text-fg" onClick={() => setNotice(null)} aria-label={t("Dismiss")}>
            <X size={12} weight="bold" />
          </button>
        </p>
      )}

      <div className="relative">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="h-[calc(100dvh-21rem)] min-h-[22rem] overflow-y-auto rounded-card bg-navy-900 py-1 font-mono text-[12px] leading-5 shadow-card"
        >
          {rows.length === 0 ? (
            <p className="px-3 py-2 text-white/40">
              {error ? "" : hasFilters ? t("No lines match these filters yet.") : t("Waiting for the API to log something…")}
            </p>
          ) : (
            rows.map((row) => (
              <Row
                key={row.seq}
                row={row}
                open={open.has(row.seq)}
                onToggle={() =>
                  setOpen((prev) => {
                    const next = new Set(prev);
                    if (next.has(row.seq)) next.delete(row.seq);
                    else next.add(row.seq);
                    return next;
                  })
                }
                onFilter={setFilter}
              />
            ))
          )}
        </div>
        {!follow && rows.length > 0 && (
          <button
            type="button"
            onClick={() => setFollow(true)}
            className="absolute bottom-3 right-5 flex cursor-pointer items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-caption font-medium text-white shadow-card transition hover:bg-accent-hover"
          >
            <ArrowDown size={12} weight="bold" />
            {t("Jump to latest")}
          </button>
        )}
      </div>
    </div>
  );
}
