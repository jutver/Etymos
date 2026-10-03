import { useEffect, useState } from "react";
import {
  UsersThree,
  CalendarDots,
  CalendarBlank,
  Repeat,
  Timer,
  Cursor,
  ArrowsClockwise,
  UserCheck,
} from "@phosphor-icons/react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";
import { StatCard } from "../../components/StatCard";
import { ChartCard, CHART_TOOLTIP_STYLE, CHART_AXIS_PROPS, CHART_COLORS } from "../../components/ChartCard";
import { DateRangePicker } from "../../components/DateRangePicker";
import { DEFAULT_DATE_RANGE, formatRangeLabel, type DateRange } from "../../lib/dashboardQueries";
import { ActivityNotSetUpError, fetchActivitySummary, type ActivitySummary } from "../../lib/activityQueries";
import { friendlyError } from "../../lib/errors";
import { t, tr } from "../../lib/i18n";

/** Human names for the funnel steps the SQL function returns (order = product journey). */
const FUNNEL_LABELS: Record<string, string> = {
  visited: tr("Visited the site"),
  signed_up: tr("Signed up"),
  check_started: tr("Started a check"),
  report_viewed: tr("Viewed a report"),
  engaged: tr("Used rewrite / comparison / export"),
  purchase_requested: tr("Requested a purchase"),
};

/** Human names for the events the web app records (apps/web/src/lib/analytics.ts). */
const EVENT_LABELS: Record<string, string> = {
  check_started: tr("Started a check"),
  check_completed: tr("Completed a check"),
  report_viewed: tr("Viewed a report"),
  source_comparison_opened: tr("Opened source comparison"),
  rewrite_opened: tr("Opened AI rewrite"),
  rewrite_accepted: tr("Accepted a rewrite"),
  report_exported: tr("Exported a report"),
  paywall_viewed: tr("Saw the paywall"),
  checkout_started: tr("Started checkout"),
  purchase_requested: tr("Submitted purchase request"),
  purchase_completed: tr("Paid for a purchase"),
};

function eventLabel(event: string): string {
  return t(EVENT_LABELS[event] ?? event.replace(/_/g, " "));
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export default function ActivityPage() {
  const [range, setRange] = useState<DateRange>(DEFAULT_DATE_RANGE);
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notSetUp, setNotSetUp] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotSetUp(false);
    fetchActivitySummary(range)
      .then((s) => !cancelled && setSummary(s))
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ActivityNotSetUpError) setNotSetUp(true);
        else setError(friendlyError(err));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [range]);

  const noEvents = !loading && summary !== null && summary.events_total === 0;
  const show = (value: string) => (loading ? "…" : value);

  const returnRate = summary && summary.active_users > 0 ? summary.returning_users / summary.active_users : 0;
  const funnel = summary?.funnel ?? [];
  const funnelMax = Math.max(1, ...funnel.map((f) => f.count));
  const features = (summary?.features ?? []).map((f) => ({ ...f, label: eventLabel(f.event) }));

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-h1 font-semibold text-fg">{t("User activity")}</h1>
          <p className="mt-1 text-body text-fg-muted">
            {t("How people actually use Etymos,")}{" "}{formatRangeLabel(range)}{t(". Active-user cards use the 1, 7 and 30 days ending")}{" "}{range.end}.
          </p>
        </div>
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      {notSetUp && (
        <p className="mt-4 rounded-card border border-border bg-surface p-4 text-caption text-fg-muted shadow-card">
          {t(new ActivityNotSetUpError().message)}
        </p>
      )}
      {error && <p className="mt-4 text-caption text-destructive">{error}</p>}
      {noEvents && (
        <p className="mt-4 rounded-card border border-border bg-surface p-4 text-caption text-fg-muted shadow-card">
          {t("No events recorded in this range yet. They appear as people use the web app (page views, checks, reports, rewrites, checkout).")}</p>
      )}

      <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label={t("DAU (last day)")} value={show(String(summary?.dau ?? 0))} icon={CalendarBlank} />
        <StatCard label={t("WAU (7 days)")} value={show(String(summary?.wau ?? 0))} icon={CalendarDots} />
        <StatCard label={t("MAU (30 days)")} value={show(String(summary?.mau ?? 0))} icon={UsersThree} />
        <StatCard label={t("Stickiness (avg DAU / MAU)")} value={show(formatPercent(summary?.stickiness ?? 0))} icon={Repeat} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label={t("Active users (range)")} value={show(String(summary?.active_users ?? 0))} icon={UserCheck} />
        <StatCard label={t("Sessions (range)")} value={show(String(summary?.sessions ?? 0))} icon={Cursor} />
        <StatCard label={t("Return rate (2+ active days)")} value={show(formatPercent(returnRate))} icon={ArrowsClockwise} />
        <StatCard
          label={t("Avg session length")}
          value={show(t("{{minutes}} min", { minutes: (summary?.avg_session_minutes ?? 0).toFixed(1) }))}
          icon={Timer}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title={t("Daily active users & sessions")} empty={!loading && (summary?.series.every((p) => p.users === 0 && p.sessions === 0) ?? true)}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={summary?.series}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey="date" {...CHART_AXIS_PROPS} tickFormatter={(d: string) => d.slice(5)} />
              <YAxis {...CHART_AXIS_PROPS} allowDecimals={false} width={28} />
              <Tooltip {...CHART_TOOLTIP_STYLE} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" name="Active users" dataKey="users" stroke={CHART_COLORS[0]} strokeWidth={2} dot={false} />
              <Line type="monotone" name="Sessions" dataKey="sessions" stroke={CHART_COLORS[1]} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <div className="rounded-card border border-border bg-surface p-5 shadow-card">
          <h3 className="text-caption font-medium text-fg-muted">{t("Conversion funnel")}</h3>
          <p className="mt-1 text-micro text-fg-subtle">
            {t("First step counts browser sessions; the others count distinct users active in the range.")}</p>
          <div className="mt-3 space-y-3">
            {funnel.length === 0 && (
              <p className="flex h-40 items-center justify-center text-caption text-fg-subtle">
                {loading ? "…" : t("No data yet.")}
              </p>
            )}
            {funnel.map((step, i) => {
              const prev = i > 0 ? (funnel[i - 1]?.count ?? 0) : 0;
              const ratio = i > 0 && prev > 0 ? step.count / prev : null;
              return (
                <div key={step.step}>
                  <div className="flex items-baseline justify-between text-caption">
                    <span className="text-fg">{t(FUNNEL_LABELS[step.step] ?? step.step)}</span>
                    <span className="font-mono text-fg">
                      {step.count}
                      {ratio !== null && ratio <= 1 && (
                        <span className="ml-2 text-fg-subtle">{formatPercent(ratio)}</span>
                      )}
                    </span>
                  </div>
                  <div className="mt-1 h-2 rounded-full bg-border">
                    <div
                      className="h-2 rounded-full bg-accent"
                      style={{ width: `${Math.max(step.count > 0 ? 2 : 0, (step.count / funnelMax) * 100)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <ChartCard title={t("Feature usage (events)")} empty={!loading && features.length === 0}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={features} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
              <XAxis type="number" {...CHART_AXIS_PROPS} allowDecimals={false} />
              <YAxis dataKey="label" type="category" {...CHART_AXIS_PROPS} width={150} />
              <Tooltip {...CHART_TOOLTIP_STYLE} />
              <Bar dataKey="events" name="Events" fill={CHART_COLORS[0]} radius={[0, 3, 3, 0]} />
              <Bar dataKey="users" name="Users" fill={CHART_COLORS[1]} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t("Top pages (views)")} empty={!loading && (summary?.top_pages.length ?? 0) === 0}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={summary?.top_pages} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
              <XAxis type="number" {...CHART_AXIS_PROPS} allowDecimals={false} />
              <YAxis dataKey="path" type="category" {...CHART_AXIS_PROPS} width={110} />
              <Tooltip {...CHART_TOOLTIP_STYLE} />
              <Bar dataKey="views" name="Views" fill={CHART_COLORS[2]} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
