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
