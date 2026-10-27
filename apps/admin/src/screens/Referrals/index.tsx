import { useEffect, useState } from "react";
import { ChatCircleText, Megaphone, Percent, XCircle } from "@phosphor-icons/react";
import {
  ResponsiveContainer,
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
import { DataTable, type Column } from "../../components/DataTable";
import { DEFAULT_DATE_RANGE, formatRangeLabel, type DateRange } from "../../lib/dashboardQueries";
import {
  REFERRAL_SOURCES,
  REFERRAL_SOURCE_LABELS,
  ReferralNotSetUpError,
  fetchReferralSummary,
  type ReferralAnswer,
  type ReferralSource,
  type ReferralSummary,
} from "../../lib/referralQueries";
import { PAGE_SIZE } from "../../lib/supabaseQueries";
import { friendlyError } from "../../lib/errors";
import { currentLocale, t, tr } from "../../lib/i18n";

const SOURCE_COLORS: Record<ReferralSource, string> = {
  facebook: CHART_COLORS[1]!,
  tiktok: CHART_COLORS[0]!,
  friend: CHART_COLORS[2]!,
  search: CHART_COLORS[3]!,
  other: "var(--color-fg-subtle)",
};

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

const COLUMNS: Column<ReferralAnswer>[] = [
  {
    key: "created_at",
    label: tr("When"),
    render: (r) => new Date(r.created_at).toLocaleString(currentLocale(), { dateStyle: "medium", timeStyle: "short" }),
    className: "whitespace-nowrap",
  },
  {
    key: "source",
    label: tr("Source"),
    render: (r) => (
      <span className="inline-flex items-center gap-2">
        <span className="size-2 rounded-full" style={{ background: SOURCE_COLORS[r.source] }} />
        {t(REFERRAL_SOURCE_LABELS[r.source])}
      </span>
    ),
  },
  {
    key: "other_text",
    label: tr("Details"),
    render: (r) => (r.other_text ? r.other_text : <span className="text-fg-subtle">—</span>),
  },
  {
    key: "user",
    label: tr("Who"),
    render: (r) => r.user?.email ?? <span className="text-fg-subtle">{t("Deleted account")}</span>,
  },
];

export default function ReferralsPage() {
  const [range, setRange] = useState<DateRange>(DEFAULT_DATE_RANGE);
  const [summary, setSummary] = useState<ReferralSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notSetUp, setNotSetUp] = useState(false);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotSetUp(false);
    setPage(0);
    fetchReferralSummary(range)
      .then((s) => !cancelled && setSummary(s))
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ReferralNotSetUpError) setNotSetUp(true);
        else setError(friendlyError(err));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [range]);

  const show = (value: string) => (loading ? "…" : value);
  const answered = summary?.answered ?? 0;
  const bySource = (summary?.bySource ?? []).map((s) => ({ ...s, label: t(REFERRAL_SOURCE_LABELS[s.source]) }));
  const top = [...bySource].sort((a, b) => b.count - a.count)[0];
  const answers = summary?.answers ?? [];
  const pageRows = answers.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-h1 font-semibold text-fg">{t("Referral sources")}</h1>
          <p className="mt-1 text-body text-fg-muted">
            {t("How signed-in users say they found Etymos, from the referral survey,")}{" "}{formatRangeLabel(range)}.
          </p>
        </div>
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      {notSetUp && (
        <p className="mt-4 rounded-card border border-border bg-surface p-4 text-caption text-fg-muted shadow-card">
          {t(new ReferralNotSetUpError().message)}
        </p>
      )}
      {error && <p className="mt-4 text-caption text-destructive">{error}</p>}

      <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label={t("Answers")} value={show(String(answered))} icon={ChatCircleText} />
        <StatCard
          label={t("Response rate")}
          value={show(formatPercent(summary && summary.shown > 0 ? answered / summary.shown : 0))}
          icon={Percent}
          hint={t("Answers out of every time the survey was closed")}
        />
        <StatCard
          label={t("Top source")}
          value={show(top && top.count > 0 ? top.label : "—")}
          icon={Megaphone}
          hint={top && top.count > 0 && answered > 0 ? formatPercent(top.count / answered) : undefined}
        />
        <StatCard label={t("Skipped")} value={show(String(summary?.skipped ?? 0))} icon={XCircle} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title={t("Answers by source")} empty={!loading && answered === 0}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={bySource} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
              <XAxis type="number" {...CHART_AXIS_PROPS} allowDecimals={false} />
              <YAxis dataKey="label" type="category" {...CHART_AXIS_PROPS} width={140} />
              <Tooltip {...CHART_TOOLTIP_STYLE} />
              <Bar dataKey="count" name={t("Answers")} fill={CHART_COLORS[0]} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t("Answers per day")} empty={!loading && answered === 0}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={summary?.series}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey="date" {...CHART_AXIS_PROPS} tickFormatter={(d: string) => d.slice(5)} />
              <YAxis {...CHART_AXIS_PROPS} allowDecimals={false} width={28} />
              <Tooltip {...CHART_TOOLTIP_STYLE} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {REFERRAL_SOURCES.map((source) => (
                <Bar
                  key={source}
                  dataKey={source}
                  name={t(REFERRAL_SOURCE_LABELS[source])}
                  stackId="sources"
                  fill={SOURCE_COLORS[source]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <h2 className="mt-6 text-h3 font-semibold text-fg">{t("Answers")}</h2>
      <div className="mt-3">
        <DataTable
          columns={COLUMNS}
          rows={pageRows}
          rowKey={(r) => String(r.id)}
          loading={loading}
          emptyMessage={tr("No answers in this range yet.")}
          page={page}
          pageCount={Math.max(1, Math.ceil(answers.length / PAGE_SIZE))}
          onPageChange={setPage}
        />
      </div>
    </div>
  );
}
