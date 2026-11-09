import { t, tr } from "./i18n";
import type { BillingCycle, PlanTier } from "./types";

// Display names for plan ids. The ids ("student", "professional") are what the
// database stores; customers see these names on the website, so admins should too.
const PLAN_LABELS: Record<PlanTier, string> = {
  free: tr("Free"),
  student: tr("Standard"),
  professional: tr("Premium"),
};

const CYCLE_LABELS: Record<BillingCycle, string> = {
  monthly: tr("Monthly"),
  annual: tr("Annual"),
};

/** "Standard" for "student"; unknown ids are shown as-is. */
export function planLabel(tier: string): string {
  const label = PLAN_LABELS[tier as PlanTier];
  return label ? t(label) : tier;
}

export function billingCycleLabel(cycle: string): string {
  const label = CYCLE_LABELS[cycle as BillingCycle];
  return label ? t(label) : cycle;
}

/** Days in a plan's check period; matches backend/api/usage.py PLAN_PERIOD_DAYS. */
export const PLAN_PERIOD_DAYS = 30;

export interface PlanChecks {
  /** The plan the server treats the account as on (Free once a paid term has ended). */
  tier: PlanTier;
  used: number;
  /** null = no monthly cap. */
  limit: number | null;
  /** null when there's no cap. */
  left: number | null;
  /** When the count next starts over. */
  resetsAt: Date;
}

/**
 * The account's plan checks as the server counts them (backend/api/usage.py
 * ensure_quota_available): a lapsed paid plan counts as Free with nothing used,
 * and a period that has run its 30 days counts as unused, even before the
 * stored counter is reset on the next check.
 */
export function planChecks(
  profile: { plan_tier: PlanTier; plan_expires_at: string | null; plan_period_start: string; checks_used_this_period: number },
  docLimits: Partial<Record<PlanTier, number | null>>,
  now: Date = new Date(),
): PlanChecks {
  const lapsed = profile.plan_tier !== "free" && !!profile.plan_expires_at && now >= new Date(profile.plan_expires_at);
  const tier: PlanTier = lapsed ? "free" : profile.plan_tier;
  const dayMs = 24 * 60 * 60 * 1000;
  let start = new Date(profile.plan_period_start);
  if (Number.isNaN(start.getTime())) start = now;
  const elapsed = now.getTime() >= start.getTime() + PLAN_PERIOD_DAYS * dayMs;
  const used = lapsed || elapsed ? 0 : profile.checks_used_this_period;
  // The next reset: the end of the current 30-day window counted from the stored start.
  const periods = Math.max(1, Math.floor((now.getTime() - start.getTime()) / (PLAN_PERIOD_DAYS * dayMs)) + 1);
  const resetsAt = new Date(start.getTime() + periods * PLAN_PERIOD_DAYS * dayMs);
  const limit = docLimits[tier] ?? null;
  return { tier, used, limit, left: limit === null ? null : Math.max(0, limit - used), resetsAt };
}
