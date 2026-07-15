import { supabase } from "@etymos/shared";

const DAYS = 30;
// MVP: client-side aggregation over a bounded recent window. Revisit with a
// SQL view/RPC if the table sizes make this slow.
const FETCH_LIMIT = 5000;

export interface DailyPoint {
  date: string;
  value: number;
}

export interface PlanDistributionPoint {
  plan: string;
  count: number;
}

export interface DashboardMetrics {
  totalUsers: number;
  mrr: number;
  signupsByDay: DailyPoint[];
  documentsByDay: DailyPoint[];
  checkoutVolumeByDay: DailyPoint[];
  planDistribution: PlanDistributionPoint[];
}

function lastNDays(n: number): string[] {
  const days: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

function bucketByDay(dates: string[], days: string[]): DailyPoint[] {
  const counts = new Map(days.map((d) => [d, 0]));
  for (const iso of dates) {
    const day = iso.slice(0, 10);
    if (counts.has(day)) counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return days.map((date) => ({ date, value: counts.get(date) ?? 0 }));
}

export async function fetchDashboardMetrics(): Promise<DashboardMetrics> {
  const [profilesRes, documentsRes, checkoutRes, plansRes] = await Promise.all([
    supabase.from("profiles").select("id, plan_tier, billing_cycle, created_at").limit(FETCH_LIMIT),
    supabase.from("documents").select("id, uploaded_at").limit(FETCH_LIMIT),
    supabase
      .from("checkout_events")
      .select("amount, created_at")
      .eq("status", "success")
      .limit(FETCH_LIMIT),
    supabase.from("plan_definitions").select("id, price_monthly, price_annual"),
  ]);

  if (profilesRes.error) throw profilesRes.error;
  if (documentsRes.error) throw documentsRes.error;
  if (checkoutRes.error) throw checkoutRes.error;
  if (plansRes.error) throw plansRes.error;

  const profiles = profilesRes.data ?? [];
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

  const days = lastNDays(DAYS);

  return {
    totalUsers: profiles.length,
    mrr,
    signupsByDay: bucketByDay(
      profiles.map((p) => p.created_at),
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
  };
}
