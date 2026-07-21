import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Users,
  CurrencyDollar,
  FileText,
  ShoppingCart,
  Flag,
  GraduationCap,
  Hourglass,
  Receipt,
} from "@phosphor-icons/react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { StatCard } from "../../components/StatCard";
import { ChartCard, CHART_TOOLTIP_STYLE, CHART_AXIS_PROPS, CHART_COLORS } from "../../components/ChartCard";
import { DateRangePicker } from "../../components/DateRangePicker";
import {
  fetchDashboardMetrics,
  formatRangeLabel,
  DEFAULT_DATE_RANGE,
  type DashboardMetrics,
  type DateRange,
} from "../../lib/dashboardQueries";
import { friendlyError } from "../../lib/errors";

function formatVND(amount: number): string {
  return new Intl.NumberFormat("vi-VN").format(Math.round(amount)) + " đ";
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/** Plagiarism severity is a functional-result signal — it must render in
 * DESIGN.md's severity colors (red/amber/yellow/green), keyed by status,
 * never the brand blue used for the other business-metric charts on this
 * page (Functional Wall Rule: blue is brand/action, never a detection result). */
const SEVERITY_CHART_COLORS: Record<string, string> = {
  clean: "var(--color-success)",
  low: "var(--color-info)",
  moderate: "var(--color-warning)",
  high: "var(--color-destructive)",
  unscored: "var(--color-fg-subtle)",
};

export default function DashboardPage() {
  const [range, setRange] = useState<DateRange>(DEFAULT_DATE_RANGE);
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchDashboardMetrics(range)
      .then((m) => !cancelled && setMetrics(m))
      .catch((err: unknown) => !cancelled && setError(friendlyError(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [range]);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-h1 font-semibold text-fg">Dashboard</h1>
          <p className="mt-1 text-body text-fg-muted">Signups, revenue, and platform activity, {formatRangeLabel(range)}.</p>
        </div>
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      {error && <p className="mt-4 text-caption text-destructive">{error}</p>}

      <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Total users" value={loading ? "…" : String(metrics?.totalUsers ?? 0)} icon={Users} />
        <StatCard label="MRR" value={loading ? "…" : formatVND(metrics?.mrr ?? 0)} icon={CurrencyDollar} />
        <StatCard
          label="Documents"
          value={loading ? "…" : String(metrics?.documentsByDay.reduce((s, p) => s + p.value, 0) ?? 0)}
          icon={FileText}
        />
        <StatCard
          label="Checkout volume"
          value={loading ? "…" : formatVND(metrics?.checkoutVolumeByDay.reduce((s, p) => s + p.value, 0) ?? 0)}
          icon={ShoppingCart}
        />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Flagged document rate"
          value={loading ? "…" : formatPercent(metrics?.flaggedDocumentRate ?? 0)}
          icon={Flag}
        />
        <Link to="/verification" className="block transition-opacity hover:opacity-80">
          <StatCard
            label="Verification queue"
            value={loading ? "…" : String(metrics?.verificationQueueDepth ?? 0)}
            icon={GraduationCap}
          />
        </Link>
        <Link to="/waitlist/access" className="block transition-opacity hover:opacity-80">
          <StatCard
            label="Pending access requests"
            value={loading ? "…" : String(metrics?.accessQueueDepth ?? 0)}
            icon={Hourglass}
          />
        </Link>
        <Link to="/waitlist/purchases" className="block transition-opacity hover:opacity-80">
          <StatCard
            label="Pending purchases"
            value={loading ? "…" : String(metrics?.purchaseQueueDepth ?? 0)}
            icon={Receipt}
          />
        </Link>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Signups over time" empty={!loading && (metrics?.signupsByDay.every((p) => p.value === 0) ?? true)}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={metrics?.signupsByDay}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey="date" {...CHART_AXIS_PROPS} tickFormatter={(d: string) => d.slice(5)} />
              <YAxis {...CHART_AXIS_PROPS} allowDecimals={false} width={28} />
              <Tooltip {...CHART_TOOLTIP_STYLE} />
              <Line type="monotone" dataKey="value" stroke={CHART_COLORS[0]} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Documents analyzed over time"
          empty={!loading && metrics?.documentsByDay.every((p) => p.value === 0)}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={metrics?.documentsByDay}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey="date" {...CHART_AXIS_PROPS} tickFormatter={(d: string) => d.slice(5)} />
              <YAxis {...CHART_AXIS_PROPS} allowDecimals={false} width={28} />
              <Tooltip {...CHART_TOOLTIP_STYLE} />
              <Line type="monotone" dataKey="value" stroke={CHART_COLORS[1]} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Checkout volume over time"
          empty={!loading && metrics?.checkoutVolumeByDay.every((p) => p.value === 0)}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={metrics?.checkoutVolumeByDay}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey="date" {...CHART_AXIS_PROPS} tickFormatter={(d: string) => d.slice(5)} />
              <YAxis {...CHART_AXIS_PROPS} width={28} />
              <Tooltip {...CHART_TOOLTIP_STYLE} formatter={(v: number) => formatVND(v)} />
              <Bar dataKey="value" fill={CHART_COLORS[2]} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Plan distribution" empty={!loading && (metrics?.planDistribution.length ?? 0) === 0}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={metrics?.planDistribution}
                dataKey="count"
                nameKey="plan"
                innerRadius={50}
                outerRadius={80}
                paddingAngle={2}
              >
                {(metrics?.planDistribution ?? []).map((entry, i) => (
                  <Cell key={entry.plan} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip {...CHART_TOOLTIP_STYLE} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Plagiarism severity distribution"
          empty={!loading && (metrics?.severityDistribution.length ?? 0) === 0}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={metrics?.severityDistribution} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
              <XAxis type="number" {...CHART_AXIS_PROPS} allowDecimals={false} />
              <YAxis dataKey="status" type="category" {...CHART_AXIS_PROPS} width={70} className="capitalize" />
              <Tooltip {...CHART_TOOLTIP_STYLE} />
              <Bar dataKey="count" radius={[0, 3, 3, 0]}>
                {(metrics?.severityDistribution ?? []).map((entry) => (
                  <Cell
                    key={entry.status}
                    fill={SEVERITY_CHART_COLORS[entry.status] ?? "var(--color-fg-subtle)"}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
