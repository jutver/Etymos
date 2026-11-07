// Server tab: the API process, the machine, the GPU and the checks running
// now, refreshed every ten seconds, plus the fixed list of server actions.
// There is no free-form command box on purpose (see backend/api/admin_ops.py).
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowClockwise } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import {
  fetchServerStatus,
  LOG_LEVELS,
  runServerAction,
  type ActionResult,
  type JobRow,
  type LogLevel,
  type ServerAction,
  type ServerStatus,
} from "../../lib/opsApi";
import { ApiError } from "../../lib/api";
import { friendlyError } from "../../lib/errors";
import { pushToast } from "../../lib/toast";
import { currentLocale, t, tn, tr } from "../../lib/i18n";
import { formatSeconds, shortJob } from "./format";

const REFRESH_MS = 10_000;

function Card({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-card border border-border bg-surface p-4 shadow-card", className)}>
      <h2 className="text-caption font-medium text-fg-muted">{title}</h2>
      <dl className="mt-3 space-y-1.5">{children}</dl>
    </section>
  );
}

function Item({ label, children, tone }: { label: string; children: ReactNode; tone?: "warning" | "error" }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-caption">
      <dt className="shrink-0 text-fg-subtle">{label}</dt>
      <dd
        className={cn(
          "min-w-0 truncate text-right font-mono text-fg",
          tone === "warning" && "text-warning",
          tone === "error" && "text-destructive",
        )}
      >
        {children}
      </dd>
    </div>
  );
}

function Meter({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-raised">
      <div
        className={cn("h-full rounded-full", pct > 90 ? "bg-destructive" : pct > 75 ? "bg-warning" : "bg-accent")}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

const STATUS_TONE: Record<JobRow["status"], string> = {
  queued: "bg-surface-raised text-fg-muted",
  processing: "bg-accent-bg text-accent",
  completed: "bg-success-bg text-success",
  failed: "bg-destructive-bg text-destructive",
};

const STATUS_LABEL: Record<JobRow["status"], string> = {
  queued: tr("Queued"),
  processing: tr("Running"),
  completed: tr("Done"),
  failed: tr("Failed"),
};

function JobsTable({ jobs, empty }: { jobs: JobRow[]; empty: string }) {
  if (!jobs.length) return <p className="py-3 text-caption text-fg-subtle">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-caption">
        <thead className="text-fg-subtle">
          <tr className="border-b border-border">
            <th className="py-2 pr-3 font-medium">{t("Check")}</th>
            <th className="py-2 pr-3 font-medium">{t("File")}</th>
            <th className="py-2 pr-3 font-medium">{t("Status")}</th>
            <th className="py-2 pr-3 font-medium">{t("Step")}</th>
            <th className="py-2 pr-3 font-medium">{t("Time")}</th>
            <th className="py-2 font-medium">{t("User")}</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.job_id} className="border-b border-border/60 align-top last:border-0">
              <td className="py-2 pr-3">
                <Link
                  to={`/logs/live?job=${encodeURIComponent(job.job_id)}`}
                  className="font-mono text-accent hover:underline"
                  title={t("See this check's log lines")}
                >
                  {shortJob(job.job_id)}
                </Link>
              </td>
              <td className="max-w-[16rem] py-2 pr-3">
                <p className="truncate text-fg" title={job.input_name ?? ""}>
                  {job.input_name || "—"}
                </p>
                <p className="text-fg-subtle">{job.input_type.toUpperCase()}</p>
              </td>
              <td className="py-2 pr-3">
                <span className={cn("rounded-full px-2 py-0.5 font-medium", STATUS_TONE[job.status])}>
                  {t(STATUS_LABEL[job.status])}
                  {job.status === "processing" && ` ${job.progress}%`}
                </span>
              </td>
              <td className="max-w-[20rem] py-2 pr-3">
                <p className="font-mono text-fg">{job.current_step}</p>
                <p className={cn("break-words", job.status === "failed" ? "text-destructive" : "text-fg-subtle")}>
                  {job.status === "failed" && job.error ? job.error : job.message}
                </p>
              </td>
              <td className="whitespace-nowrap py-2 pr-3 font-mono text-fg-muted">
                {job.status === "queued" || job.status === "processing"
                  ? t("{{total}} (this step {{step}})", {
                      total: formatSeconds(job.age_seconds),
                      step: formatSeconds(job.step_seconds),
                    })
                  : new Date(job.updated_at).toLocaleTimeString(currentLocale())}
              </td>
              <td className="py-2 font-mono text-fg-muted">
                {job.user_id ? (
                  <Link to={`/users/${job.user_id}`} className="hover:text-accent hover:underline">
                    {job.user_id.slice(0, 8)}
                  </Link>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function describeResult(result: ActionResult): string {
  switch (result.action) {
    case "log-level":
      return t("Log level is now {{level}} (was {{previous}}) until the API restarts.", {
        level: result.level ?? "?",
        previous: result.previous ?? "?",
      });
    case "dump-threads":
      return t("Wrote the stacks of {{count}} threads to the log. Open Live log and search for \"stack\".", {
        count: result.threads ?? 0,
      });
    case "free-gpu":
      return result.freed?.length
        ? t("Unloaded: {{models}}.", { models: result.freed.join(", ") })
        : t("Nothing to unload: every loaded model is in use, or none are loaded.");
    case "run-notifications":
    case "poll-support-inbox": {
      const counts = Object.entries(result.counts ?? {}).filter(([, n]) => n > 0);
      return counts.length ? counts.map(([k, n]) => `${k}: ${n}`).join(", ") : t("Nothing to do.");
    }
    case "restart-api":
      return t("The API is restarting. It's usually back within a minute.");
  }
}

interface ActionDef {
  action: Exclude<ServerAction, "log-level" | "restart-api">;
  label: string;
  description: string;
}

const ACTIONS: ActionDef[] = [
  {
    action: "dump-threads",
    label: tr("Write thread stacks to the log"),
    description: tr("For a check that seems stuck: shows what every thread is doing right now."),
  },
  {
    action: "free-gpu",
    label: tr("Unload idle GPU models"),
    description: tr("Frees GPU memory held by models no check is using. They load again when needed."),
  },
  {
    action: "run-notifications",
    label: tr("Send due notifications now"),
    description: tr("Receipts, plan reminders and verification results normally sent every 5 minutes."),
  },
  {
    action: "poll-support-inbox",
    label: tr("Check the support inbox now"),
    description: tr("Turns new emails into tickets instead of waiting for the next minute's check."),
  },
];

export default function ServerPage() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<ServerAction | null>(null);
  const [level, setLevel] = useState<LogLevel>("INFO");
  const [confirmRestart, setConfirmRestart] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchServerStatus();
      setStatus(next);
      setError(null);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (status) setLevel(status.process.log_level);
  }, [status?.process.log_level]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(action: ServerAction, body: { level?: LogLevel; force?: boolean } = {}) {
    setBusy(action);
    try {
      const result = await runServerAction(action, body);
      pushToast({ kind: "success", title: t("Done"), description: describeResult(result) });
      setConfirmRestart(false);
      if (action !== "restart-api") void load();
    } catch (err) {
      pushToast({
        kind: err instanceof ApiError && err.status === 409 ? "warning" : "error",
        title: t("Couldn't run that"),
        description: friendlyError(err),
      });
    } finally {
      setBusy(null);
    }
  }

  const s = status;
  const memTotal = s?.memory.system_total_mb ?? null;
  const memFree = s?.memory.system_available_mb ?? null;
  const activeJobs = s?.jobs.active.length ?? 0;
  const actionButton =
    "cursor-pointer rounded-control border border-border px-3 py-1.5 text-caption font-medium text-fg transition hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-caption text-fg-subtle">
          {s ? t("Updated {{time}} · refreshes every 10 seconds", { time: new Date(s.checked_at).toLocaleTimeString(currentLocale()) }) : ""}
        </p>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="flex cursor-pointer items-center gap-1.5 rounded-control border border-border px-3 py-1.5 text-caption font-medium text-fg-muted transition hover:bg-surface-raised disabled:opacity-60"
        >
          <ArrowClockwise size={14} weight="bold" className={cn(loading && "animate-spin")} />
          {t("Refresh")}
        </button>
      </div>

      {error && (
        <p className="rounded-card border border-destructive/40 bg-destructive-bg px-3 py-2 text-caption text-destructive">
          {error}
        </p>
      )}

      {s && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Card title={t("API process")}>
              <Item label={t("Up for")}>{s.process.uptime}</Item>
              <Item label={t("Started")}>{new Date(s.process.started_at).toLocaleString(currentLocale())}</Item>
              <Item label={t("Version")}>
                <span title={s.process.commit}>{s.process.commit}</span>
              </Item>
              <Item label={t("Process")}>
                {s.process.pid} · {tn(s.process.threads, "{{count}} thread", "{{count}} threads")}
              </Item>
              <Item label={t("Log level")}>{s.process.log_level}</Item>
              <Item label={t("Python")}>{s.process.python}</Item>
            </Card>

            <Card title={t("Machine")}>
              <Item label={t("Host")}>{s.host.name}</Item>
              <Item label={t("Load (1/5/15 min)")}>
                {s.host.load ? s.host.load.join(" / ") : "—"}
                {s.host.cpus ? ` · ${tn(s.host.cpus, "{{count}} CPU", "{{count}} CPUs")}` : ""}
              </Item>
              <div>
                <Item label={t("Memory free")} tone={memFree !== null && memTotal && memFree / memTotal < 0.1 ? "error" : undefined}>
                  {memFree !== null && memTotal ? `${(memFree / 1024).toFixed(1)} / ${(memTotal / 1024).toFixed(1)} GB` : "—"}
                </Item>
                {memFree !== null && memTotal ? <Meter used={memTotal - memFree} total={memTotal} /> : null}
              </div>
              <Item label={t("API memory")}>
                {s.memory.rss_mb !== null ? `${Math.round(s.memory.rss_mb)} MB` : "—"} ·{" "}
                {t("peak {{mb}} MB", { mb: Math.round(s.memory.peak_mb) })}
              </Item>
              {s.host.disk && (
                <div>
                  <Item label={t("Disk free")} tone={s.host.disk.used_percent > 90 ? "error" : undefined}>
                    {s.host.disk.free_gb} / {s.host.disk.total_gb} GB
                  </Item>
                  <Meter used={s.host.disk.total_gb - s.host.disk.free_gb} total={s.host.disk.total_gb} />
                </div>
              )}
            </Card>

            <Card title={t("GPU")}>
              {s.gpu.available ? (
                <>
                  <Item label={t("Card")}>{s.gpu.name}</Item>
                  {s.gpu.free_gb !== undefined && s.gpu.total_gb !== undefined && (
                    <div>
                      <Item label={t("Memory free")}>
                        {s.gpu.free_gb} / {s.gpu.total_gb} GB
                      </Item>
                      <Meter used={s.gpu.total_gb - s.gpu.free_gb} total={s.gpu.total_gb} />
                    </div>
                  )}
                  {s.gpu.allocated_gb !== undefined && (
                    <Item label={t("Used by models")}>
                      {s.gpu.allocated_gb} GB · {t("peak {{gb}} GB", { gb: s.gpu.peak_gb ?? "?" })}
                    </Item>
                  )}
                </>
              ) : (
                <Item label={t("Card")}>{s.gpu.error ?? t("None (running on CPU)")}</Item>
              )}
              <Item label={t("Check slots")} tone={s.gpu.queue.waiting > 0 ? "warning" : undefined}>
                {t("{{running}}/{{slots}} busy · {{waiting}} waiting", {
                  running: s.gpu.queue.running,
                  slots: s.gpu.queue.slots,
                  waiting: s.gpu.queue.waiting,
                })}
              </Item>
              <Item label={t("Models loaded")}>
                {s.gpu.models.length
                  ? s.gpu.models.map((m) => `${m.name}${m.in_use ? "*" : ""}`).join(", ")
                  : t("none")}
              </Item>
            </Card>

            <Card title={t("Background work")}>
              <Item label={t("Notifications")} tone={s.background.notifications ? undefined : "warning"}>
                {s.background.notifications ? t("Running") : t("Not running")}
              </Item>
              <Item label={t("Support inbox")} tone={s.background.support_inbox ? undefined : "warning"}>
                {s.background.support_inbox ? t("Running") : t("Not running")}
              </Item>
              <Item label={t("Checks since start")}>
                {Object.values(s.jobs.counts).reduce((a, b) => a + b, 0)}
              </Item>
              <Item label={t("Failed since start")} tone={s.jobs.counts.failed ? "error" : undefined}>
                {s.jobs.counts.failed ?? 0}
              </Item>
              <Item label={t("Auto-restart")}>{s.process.supervised ? t("Supervisor") : t("Not supervised")}</Item>
            </Card>
          </div>

          <section className="rounded-card border border-border bg-surface p-4 shadow-card">
            <h2 className="text-caption font-medium text-fg-muted">
              {t("Checks running now")} {activeJobs > 0 && <span className="text-fg">({activeJobs})</span>}
            </h2>
            <JobsTable jobs={s.jobs.active} empty={t("No checks are running.")} />
          </section>

          <section className="rounded-card border border-border bg-surface p-4 shadow-card">
            <h2 className="text-caption font-medium text-fg-muted">{t("Recently finished checks")}</h2>
            <JobsTable jobs={s.jobs.recent} empty={t("No checks have finished since the API started.")} />
          </section>
        </>
      )}

      <section className="rounded-card border border-border bg-surface p-4 shadow-card">
        <h2 className="text-body font-semibold text-fg">{t("Actions")}</h2>
        <p className="mt-0.5 text-caption text-fg-muted">
          {t("Each action is written to the log and the audit log with your name.")}
        </p>

        <div className="mt-4 divide-y divide-border">
          <div className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="text-body font-medium text-fg">{t("Log level")}</p>
              <p className="text-caption text-fg-muted">
                {t("DEBUG adds every job poll, queue move and background pass. Goes back to normal when the API restarts.")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={level}
                onChange={(e) => setLevel(e.target.value as LogLevel)}
                aria-label={t("Log level")}
                className="h-8 cursor-pointer rounded-control border border-border bg-surface px-2 text-caption text-fg outline-none focus:border-accent"
              >
                {LOG_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={actionButton}
                disabled={busy !== null || !s || level === s.process.log_level}
                onClick={() => void run("log-level", { level })}
              >
                {busy === "log-level" ? t("Applying…") : t("Apply")}
              </button>
            </div>
          </div>

          {ACTIONS.map((a) => (
            <div key={a.action} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="text-body font-medium text-fg">{t(a.label)}</p>
                <p className="text-caption text-fg-muted">{t(a.description)}</p>
              </div>
              <button type="button" className={actionButton} disabled={busy !== null} onClick={() => void run(a.action)}>
                {busy === a.action ? t("Running…") : t("Run")}
              </button>
            </div>
          ))}

          <div className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="text-body font-medium text-fg">{t("Restart the API")}</p>
              <p className="text-caption text-fg-muted">
                {activeJobs > 0
                  ? t("{{count}} check(s) are running and would be lost; their users would see \"interrupted\".", {
                      count: activeJobs,
                    })
                  : t("Stops and starts the API process. Pages show an error for up to a minute.")}
              </p>
            </div>
            {confirmRestart ? (
              <div className="flex items-center gap-2">
                <button type="button" className={actionButton} onClick={() => setConfirmRestart(false)} disabled={busy !== null}>
                  {t("Cancel")}
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void run("restart-api", { force: activeJobs > 0 })}
                  className="cursor-pointer rounded-control bg-destructive px-3 py-1.5 text-caption font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                >
                  {busy === "restart-api"
                    ? t("Restarting…")
                    : activeJobs > 0
                      ? t("Restart and lose {{count}} check(s)", { count: activeJobs })
                      : t("Yes, restart")}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className={cn(actionButton, "border-destructive/40 text-destructive hover:bg-destructive-bg")}
                disabled={busy !== null || !s?.process.supervised}
                title={s && !s.process.supervised ? t("This API isn't running under supervisor, so it can't restart itself.") : undefined}
                onClick={() => setConfirmRestart(true)}
              >
                {t("Restart…")}
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
