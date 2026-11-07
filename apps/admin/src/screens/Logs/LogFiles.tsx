// Log files tab: the end of the log files supervisord writes on the server
// (API across restarts, auto-deploy, last test run, tunnel, supervisor).
import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, DownloadSimple, MagnifyingGlass } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { fetchLogFile, fetchLogFiles, type LogFileInfo, type LogFileTail } from "../../lib/opsApi";
import { friendlyError } from "../../lib/errors";
import { currentLocale, t, tr } from "../../lib/i18n";
import { download, formatBytes, lineTone, TONE_CLASS } from "./format";

const FILE_LABELS: Record<string, string> = {
  api: tr("API"),
  "api-out": tr("API output"),
  deploy: tr("Auto-deploy"),
  tests: tr("Last test run"),
  tunnel: tr("Tunnel"),
  supervisor: tr("Supervisor"),
};

const FILE_DESCRIPTIONS: Record<string, string> = {
  api: tr("Everything the API logged, across restarts."),
  "api-out": tr("Anything written straight to the API's output."),
  deploy: tr("Pulls, test runs, restarts and rollbacks."),
  tests: tr("The backend tests run before the last deploy."),
  tunnel: tr("The Cloudflare tunnel that carries traffic to the API."),
  supervisor: tr("When each process started, stopped or crashed."),
};

const LINE_COUNTS = [200, 500, 2000, 5000];

const control =
  "flex h-8 cursor-pointer items-center gap-1.5 rounded-control border border-border bg-surface px-2.5 text-caption font-medium text-fg-muted transition hover:bg-surface-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-50";

export default function LogFilesPage() {
  const [files, setFiles] = useState<LogFileInfo[] | null>(null);
  const [dir, setDir] = useState("");
  const [selected, setSelected] = useState("api");
  const [lines, setLines] = useState(500);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [tail, setTail] = useState<LogFileTail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchLogFiles()
      .then((r) => {
        setFiles(r.files);
        setDir(r.dir);
      })
      .catch((err: unknown) => setError(friendlyError(err)));
  }, [reload]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchLogFile(selected, lines, query)
      .then((r) => {
        if (cancelled) return;
        setTail(r);
        // Newest lines are at the bottom.
        requestAnimationFrame(() => {
          const el = scrollRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
      })
      .catch((err: unknown) => !cancelled && setError(friendlyError(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selected, lines, query, reload]);

  return (
    <div className="grid gap-4 lg:grid-cols-[15rem_1fr]">
      <aside className="space-y-1">
        {(files ?? []).map((file) => (
          <button
            key={file.name}
            type="button"
            onClick={() => setSelected(file.name)}
            className={cn(
              "w-full cursor-pointer rounded-control border px-3 py-2 text-left transition",
              selected === file.name
                ? "border-accent/40 bg-accent-bg"
                : "border-transparent hover:border-border hover:bg-surface",
            )}
          >
            <p className={cn("text-body font-medium", selected === file.name ? "text-accent" : "text-fg")}>
              {t(FILE_LABELS[file.name] ?? file.name)}
            </p>
            <p className="text-caption text-fg-subtle">
              {file.exists
                ? `${formatBytes(file.size_bytes)} · ${new Date(file.modified_at!).toLocaleString(currentLocale(), {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}`
                : t("Not on this server")}
            </p>
          </button>
        ))}
        {dir && <p className="px-3 pt-2 font-mono text-micro break-all text-fg-subtle">{dir}</p>}
      </aside>

      <section className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(search);
            }}
            className="relative"
          >
            <MagnifyingGlass size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
            <input
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                if (!e.target.value) setQuery("");
              }}
              placeholder={t("Search, then press Enter")}
              aria-label={t("Search this file")}
              className="h-8 w-60 rounded-control border border-border bg-surface pl-8 pr-2 text-caption text-fg outline-none focus:border-accent"
            />
          </form>
          <select
            value={lines}
            onChange={(e) => setLines(Number(e.target.value))}
            aria-label={t("Lines to show")}
            className="h-8 cursor-pointer rounded-control border border-border bg-surface px-2 text-caption text-fg outline-none focus:border-accent"
          >
            {LINE_COUNTS.map((n) => (
              <option key={n} value={n}>
                {t("Last {{count}} lines", { count: n.toLocaleString() })}
              </option>
            ))}
          </select>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" className={control} onClick={() => setReload((n) => n + 1)} disabled={loading}>
              <ArrowClockwise size={14} weight="bold" className={cn(loading && "animate-spin")} />
              {t("Refresh")}
            </button>
            <button
              type="button"
              className={control}
              disabled={!tail?.lines.length}
              onClick={() => tail && download(`${tail.file}.txt`, tail.lines.join("\n") + "\n")}
            >
              <DownloadSimple size={14} weight="bold" />
              {t("Download")}
            </button>
          </div>
        </div>

        <p className="text-caption text-fg-muted">
          {FILE_DESCRIPTIONS[selected] ? t(FILE_DESCRIPTIONS[selected]) : null}
          {tail?.exists && (
            <span className="ml-2 font-mono text-fg-subtle">
              {tail.file}
              {tail.more && ` · ${t("older lines not shown")}`}
            </span>
          )}
        </p>

        {error && (
          <p className="rounded-card border border-destructive/40 bg-destructive-bg px-3 py-2 text-caption text-destructive">
            {error}
          </p>
        )}

        <div
          ref={scrollRef}
          className="h-[calc(100dvh-22rem)] min-h-[22rem] overflow-auto rounded-card bg-navy-900 px-3 py-2 font-mono text-[12px] leading-5 shadow-card"
        >
          {tail && !tail.exists ? (
            <p className="text-white/40">
              {t("This file doesn't exist on the server yet. It appears once that process writes to it.")}
            </p>
          ) : tail && tail.lines.length === 0 ? (
            <p className="text-white/40">{query ? t("No lines match.") : t("The file is empty.")}</p>
          ) : (
            tail?.lines.map((line, i) => (
              <div key={i} className={cn("whitespace-pre-wrap break-words", TONE_CLASS[lineTone(line)])}>
                {line || " "}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
