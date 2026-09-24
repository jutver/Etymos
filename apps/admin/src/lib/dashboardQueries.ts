import { supabase } from "@etymos/shared";
import { t, tr } from "./i18n";

// MVP: client-side aggregation over a date-range-bounded query. Revisit with a
// SQL view/RPC if the table sizes make this slow.
const FETCH_LIMIT = 5000;

export type DateRangePreset = "7d" | "30d" | "90d" | "1y" | "custom";

export interface DateRange {
  preset: DateRangePreset;
  /** yyyy-mm-dd, inclusive */
  start: string;
  /** yyyy-mm-dd, inclusive */
  end: string;
}

const PRESET_DAYS: Record<Exclude<DateRangePreset, "custom">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "1y": 365,
};

const PRESET_LABELS: Record<Exclude<DateRangePreset, "custom">, string> = {
  "7d": tr("last 7 days"),
  "30d": tr("last 30 days"),
  "90d": tr("last 90 days"),
  "1y": tr("last year"),
};

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function presetRange(preset: Exclude<DateRangePreset, "custom">, now: Date = new Date()): DateRange {
  const days = PRESET_DAYS[preset];
  const end = new Date(now);
  const start = new Date(now);
  start.setDate(start.getDate() - (days - 1));
  return { preset, start: toISODate(start), end: toISODate(end) };
}

export const DEFAULT_DATE_RANGE: DateRange = presetRange("30d");

export function formatRangeLabel(range: DateRange): string {
  if (range.preset !== "custom") return t(PRESET_LABELS[range.preset]);
  return t("{{start}} to {{end}}", { start: range.start, end: range.end });
}

function daysInRange(start: string, end: string): string[] {
  const days: string[] = [];
  const cur = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  while (cur <= last) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

function rangeBounds(range: DateRange): { gte: string; lte: string } {
  return { gte: `${range.start}T00:00:00.000Z`, lte: `${range.end}T23:59:59.999Z` };
}

function bucketByDay(dates: string[], days: string[]): DailyPoint[] {
  const counts = new Map(days.map((d) => [d, 0]));
  for (const iso of dates) {
    const day = iso.slice(0, 10);
    if (counts.has(day)) counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return days.map((date) => ({ date, value: counts.get(date) ?? 0 }));
}

export interface DailyPoint {
  date: string;
  value: number;
}

export interface PlanDistributionPoint {
  plan: string;
  count: number;
}

export interface SeverityDistributionPoint {
  status: string;
  count: number;
}

export interface DashboardMetrics {
  /** Lifetime total, not scoped to the selected range. */
  totalUsers: number;
  /** Current MRR snapshot from active profiles, not scoped to the selected range. */
  mrr: number;
  signupsByDay: DailyPoint[];
  documentsByDay: DailyPoint[];
  checkoutVolumeByDay: DailyPoint[];
  /** Current plan mix snapshot, not scoped to the selected range. */
  planDistribution: PlanDistributionPoint[];
  /** documents.status breakdown for documents uploaded within the selected range. */
  severityDistribution: SeverityDistributionPoint[];
  /** Share (0..1) of in-range documents with moderation_status = 'flagged'. */
  flaggedDocumentRate: number;
  /** Total documents uploaded within the selected range (denominator for flaggedDocumentRate). */
  documentsInRange: number;
  /** Count of pending student_verification_requests. Not range-scoped — this is a live queue depth. */
  verificationQueueDepth: number;
  /** Count of profiles still waiting on app access. Live queue depth, not range-scoped. */
  accessQueueDepth: number;
  /** Count of pending checkout_events awaiting approval. Live queue depth, not range-scoped. */
  purchaseQueueDepth: number;
}

const SEVERITY_ORDER = ["clean", "low", "moderate", "high", "unscored"];

export async function fetchDashboardMetrics(range: DateRange): Promise<DashboardMetrics> {
  const { gte, lte } = rangeBounds(range);
  const days = daysInRange(range.start, range.end);

  const [
    profilesRes,
    signupsRes,
    documentsRes,
    checkoutRes,
    plansRes,
    verificationQueueRes,
    accessQueueRes,
    purchaseQueueRes,
  ] = await Promise.all([
    supabase.from("profiles").select("id, plan_tier, billing_cycle").limit(FETCH_LIMIT),
    supabase.from("profiles").select("created_at").gte("created_at", gte).lte("created_at", lte).limit(FETCH_LIMIT),
    supabase
      .from("documents")
      .select("uploaded_at, status, moderation_status")
      .gte("uploaded_at", gte)
      .lte("uploaded_at", lte)
      .limit(FETCH_LIMIT),
    supabase
      .from("checkout_events")
      .select("amount, created_at")
      .eq("status", "success")
      .gte("created_at", gte)
      .lte("created_at", lte)
      .limit(FETCH_LIMIT),
    supabase.from("plan_definitions").select("id, price_monthly, price_annual"),
    supabase.from("student_verification_requests").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("profiles").select("id", { count: "exact", head: true }).eq("access_status", "waitlisted"),
    supabase.from("checkout_events").select("id", { count: "exact", head: true }).eq("status", "pending"),
  ]);

  if (profilesRes.error) throw profilesRes.error;
  if (signupsRes.error) throw signupsRes.error;
  if (documentsRes.error) throw documentsRes.error;
  if (checkoutRes.error) throw checkoutRes.error;
  if (plansRes.error) throw plansRes.error;
  if (verificationQueueRes.error) throw verificationQueueRes.error;
  if (accessQueueRes.error) throw accessQueueRes.error;
  if (purchaseQueueRes.error) throw purchaseQueueRes.error;

  const profiles = profilesRes.data ?? [];
  const signups = signupsRes.data ?? [];
  const documents = documentsRes.data ?? [];
  const checkoutEvents = checkoutRes.data ?? [];
  const plans = plansRes.data ?? [];

  const priceByPlan = new Map(plans.map((p) => [p.id, p]));

  const mrr = profiles.reduce((sum, p) => {
    const plan = priceByPlan.get(p.plan_tier);
    if (!plan || p.plan_tier === "free") return sum;
    return sum + (p.billing_cycle === "annual" ? plan.price_annual / 12 : plan.price_monthly);
  }, 0);

  const planCounts = new Map<string, number>();
  for (const p of profiles) {
    planCounts.set(p.plan_tier, (planCounts.get(p.plan_tier) ?? 0) + 1);
  }

  const severityCounts = new Map<string, number>();
  let flaggedCount = 0;
  for (const d of documents) {
    const status = d.status ?? "unscored";
    severityCounts.set(status, (severityCounts.get(status) ?? 0) + 1);
    if (d.moderation_status === "flagged") flaggedCount += 1;
  }

  return {
    totalUsers: profiles.length,
    mrr,
    signupsByDay: bucketByDay(
      signups.map((p) => p.created_at),
      days,
    ),
    documentsByDay: bucketByDay(
      documents.map((d) => d.uploaded_at),
      days,
    ),
    checkoutVolumeByDay: (() => {
      const totals = new Map(days.map((d) => [d, 0]));
      for (const c of checkoutEvents) {
        const day = c.created_at.slice(0, 10);
        if (totals.has(day)) totals.set(day, (totals.get(day) ?? 0) + Number(c.amount ?? 0));
      }
      return days.map((date) => ({ date, value: totals.get(date) ?? 0 }));
    })(),
    planDistribution: Array.from(planCounts.entries()).map(([plan, count]) => ({ plan, count })),
    severityDistribution: SEVERITY_ORDER.filter((s) => severityCounts.has(s)).map((status) => ({
      status,
      count: severityCounts.get(status) ?? 0,
    })),
    flaggedDocumentRate: documents.length ? flaggedCount / documents.length : 0,
    documentsInRange: documents.length,
    verificationQueueDepth: verificationQueueRes.count ?? 0,
    accessQueueDepth: accessQueueRes.count ?? 0,
    purchaseQueueDepth: purchaseQueueRes.count ?? 0,
  };
}
