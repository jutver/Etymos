import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Bank,
  ChartBar,
  CurrencyCircleDollar,
  DownloadSimple,
  HourglassMedium,
  Receipt,
  Warning,
  Lightning,
} from "@phosphor-icons/react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { StatCard } from "../../components/StatCard";
import { StatusBadge } from "../../components/StatusBadge";
import { ChartCard, CHART_TOOLTIP_STYLE, CHART_AXIS_PROPS, CHART_COLORS } from "../../components/ChartCard";
import { DateRangePicker } from "../../components/DateRangePicker";
import { DEFAULT_DATE_RANGE, formatRangeLabel, type DateRange } from "../../lib/dashboardQueries";
import { exportTransactionsCsv, fetchRevenueOverview, type RevenueOverview } from "../../lib/revenueQueries";
import { friendlyError } from "../../lib/errors";
import { cn } from "@etymos/shared";
import { t, tn, currentLocale } from "../../lib/i18n";
import {
  TRANSACTION_STATUS_LABELS,
  describeItem,
  describeProductKey,
  formatCompactVND,
  formatDateTime,
  formatVND,
  transactionTone,
} from "./format";

export default function RevenueOverviewPage() {
  const [range, setRange] = useState<DateRange>(DEFAULT_DATE_RANGE);
  const [data, setData] = useState<RevenueOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchRevenueOverview(range)
      .then((d) => !cancelled && setData(d))
      .catch((err: unknown) => !cancelled && setError(friendlyError(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [range]);

  async function handleExport() {
    setExporting(true);
    try {
      const csv = await exportTransactionsCsv(range);
      // BOM so Excel opens Vietnamese text as UTF-8.
      const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `etymos-transactions-${range.start}-to-${range.end}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setExporting(false);
    }
  }

  const value = (fn: (d: RevenueOverview) => string) => (loading || !data ? "…" : fn(data));
  const totalSplit = (data?.automatic ?? 0) + (data?.manual ?? 0);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-body text-fg-muted">{t("Showing {{range}} (Vietnam time).", { range: formatRangeLabel(range) })}</p>
        <div className="flex flex-wrap items-center gap-2">
          <DateRangePicker value={range} onChange={setRange} />
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={exporting}
            className="flex cursor-pointer items-center gap-1.5 rounded-control border border-border bg-surface px-3 py-2 text-caption font-medium text-fg shadow-card transition hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
          >
            <DownloadSimple size={14} weight="bold" />
            {exporting ? t("Exporting…") : t("Export CSV")}
          </button>
        </div>
      </div>

      {error && <p className="mt-4 text-caption text-destructive">{error}</p>}

      <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label={t("Revenue")} value={value((d) => formatVND(d.revenue))} icon={CurrencyCircleDollar} />
        <StatCard label={t("Paid orders")} value={value((d) => String(d.paidOrders))} icon={Receipt} />
        <StatCard label={t("Average order")} value={value((d) => formatVND(d.averageOrder))} icon={ChartBar} />
        <StatCard label={t("Received via SePay")} value={value((d) => formatVND(d.received))} icon={Bank} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Link to="/revenue/transactions" className="block transition-opacity hover:opacity-80">
          <div
            className={cn(
              "rounded-card border bg-surface p-5 shadow-card",
              (data?.needsAttention ?? 0) > 0 ? "border-warning/50" : "border-border",
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-caption font-medium text-fg-muted">{t("Transfers needing attention")}</span>
              <Warning size={16} weight="bold" className={(data?.needsAttention ?? 0) > 0 ? "text-warning" : "text-fg-subtle"} />
            </div>
            <p className="mt-2 font-mono text-h1 font-semibold text-fg">{value((d) => String(d.needsAttention))}</p>
          </div>
        </Link>
        <Link to="/revenue/orders?filter=awaiting" className="block transition-opacity hover:opacity-80">
          <StatCard label={t("Orders awaiting payment")} value={value((d) => String(d.awaitingPayment))} icon={HourglassMedium} />
        </Link>
        <div className="rounded-card border border-border bg-surface p-5 shadow-card">
          <div className="flex items-center justify-between">
            <span className="text-caption font-medium text-fg-muted">{t("Paid automatically")}</span>
            <Lightning size={16} weight="bold" className="text-fg-subtle" />
          </div>
          <p className="mt-2 font-mono text-h1 font-semibold text-fg">
            {loading || !data ? "…" : totalSplit ? `${Math.round((data.automatic / totalSplit) * 100)}%` : "—"}
          </p>
          {data && data.manual > 0 && (
            <p className="mt-1 text-caption text-fg-subtle">{t("{{amount}} approved by hand", { amount: formatVND(data.manual) })}</p>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title={t("Revenue by day")} empty={!loading && (data?.revenue ?? 0) === 0}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data?.revenueByDay}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey="date" {...CHART_AXIS_PROPS} tickFormatter={(d: string) => d.slice(5)} />
              <YAxis {...CHART_AXIS_PROPS} width={40} tickFormatter={formatCompactVND} />
              <Tooltip {...CHART_TOOLTIP_STYLE} formatter={(v: number) => [formatVND(v), t("Revenue")]} />
              <Bar dataKey="value" fill={CHART_COLORS[0]} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t("Money received by day")} empty={!loading && (data?.received ?? 0) === 0}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data?.receivedByDay}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey="date" {...CHART_AXIS_PROPS} tickFormatter={(d: string) => d.slice(5)} />
              <YAxis {...CHART_AXIS_PROPS} width={40} tickFormatter={formatCompactVND} />
              <Tooltip {...CHART_TOOLTIP_STYLE} formatter={(v: number) => [formatVND(v), t("Received")]} />
              <Bar dataKey="value" fill={CHART_COLORS[1]} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-card border border-border bg-surface p-5 shadow-card">
          <h3 className="text-caption font-medium text-fg-muted">{t("Revenue by product")}</h3>
          {!loading && (data?.byProduct.length ?? 0) === 0 ? (
            <p className="py-10 text-center text-caption text-fg-subtle">{t("No data yet.")}</p>
          ) : (
            <ul className="mt-3 space-y-3">
              {(data?.byProduct ?? []).map((p) => (
                <li key={p.key}>
                  <div className="flex items-baseline justify-between gap-3 text-body">
                    <span className="text-fg">{describeProductKey(p.key)}</span>
                    <span className="font-mono text-fg">{formatVND(p.amount)}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-raised">
                      <div
                        className="h-full rounded-full bg-accent"
                        style={{ width: `${data?.revenue ? (p.amount / data.revenue) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="w-20 text-right text-caption text-fg-subtle">
                      {tn(p.count, "{{count}} order", "{{count}} orders")}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-card border border-border bg-surface p-5 shadow-card">
          <div className="flex items-center justify-between">
            <h3 className="text-caption font-medium text-fg-muted">{t("Latest transfers")}</h3>
            <Link to="/revenue/transactions?filter=all" className="text-caption font-medium text-accent hover:underline">
              {t("See all")}</Link>
          </div>
          {!loading && (data?.recentPayments.length ?? 0) === 0 ? (
            <p className="py-10 text-center text-caption text-fg-subtle">{t("No transfers yet.")}</p>
          ) : (
            <ul className="mt-2 divide-y divide-border">
              {(data?.recentPayments ?? []).map((tx) => (
                <li key={tx.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-body text-fg">
                      {tx.checkout_events
                        ? `${tx.checkout_events.profiles?.email ?? "—"} · ${describeItem(tx.checkout_events)}`
                        : (tx.content ?? "—")}
                    </p>
                    <p className="text-caption text-fg-subtle">{formatDateTime(tx.transaction_date ?? tx.received_at, currentLocale())}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="font-mono text-body text-fg">{formatVND(tx.amount)}</span>
                    <StatusBadge label={TRANSACTION_STATUS_LABELS[tx.status]} tone={transactionTone(tx.status)} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
