import type { PlanTier } from "@etymos/shared";

/**
 * Why the user landed on /paywall. Callers pass it in the query string so the
 * page can say what actually happened: running out of checks and clicking a
 * feature your plan doesn't include need different headlines and offers.
 */
export type PaywallReason =
  | "checks" // monthly plan quota used up
  | "standard-credits" // tried to run a check on Standard credits with none left
  | "premium-credits" // same, Premium credits
  | "export" // PDF export
  | "semantic" // matches found only by Semantic Detection
  | "ai-detection" // AI-generated content detection
  | "rewrite"; // AI Rewrite Assistant

const REASONS: readonly PaywallReason[] = [
  "checks",
  "standard-credits",
  "premium-credits",
  "export",
  "semantic",
  "ai-detection",
  "rewrite",
];

/** `documentId` lets a feature paywall offer to spend a credit on that document. */
export function paywallPath(reason?: PaywallReason, documentId?: string): string {
  const params = new URLSearchParams();
  if (reason) params.set("reason", reason);
  if (documentId) params.set("doc", documentId);
  const query = params.toString();
  return query ? `/paywall?${query}` : "/paywall";
}

export function parsePaywallReason(value: string | null): PaywallReason | null {
  return REASONS.includes(value as PaywallReason) ? (value as PaywallReason) : null;
}

/** Quota/credit shortfalls — buying credits is a valid way out of these. */
export function isBalanceReason(reason: PaywallReason | null): boolean {
  return reason === "checks" || reason === "standard-credits" || reason === "premium-credits";
}

const PLAN_RANK: Record<PlanTier, number> = { free: 0, student: 1, professional: 2 };

/** The cheapest plan that unlocks a feature reason (null for balance reasons). */
export function requiredPlanFor(reason: PaywallReason | null): Exclude<PlanTier, "free"> | null {
  switch (reason) {
    case "export":
    case "semantic":
    case "ai-detection":
      return "student";
    case "rewrite":
      return "professional";
    default:
      return null;
  }
}

/** The higher of the user's plan and the tier a document was unlocked to. */
export function effectiveTier(plan: PlanTier, unlockedTier?: Exclude<PlanTier, "free">): PlanTier {
  return unlockedTier && PLAN_RANK[unlockedTier] > PLAN_RANK[plan] ? unlockedTier : plan;
}

/** Paid plans worth offering: above the user's current plan and at least the
 * required one. Empty when the current plan already unlocks the feature. */
export function upgradePlansFor(current: PlanTier, reason: PaywallReason | null): Exclude<PlanTier, "free">[] {
  const required = requiredPlanFor(reason);
  if (required && PLAN_RANK[current] >= PLAN_RANK[required]) return [];
  const floor = Math.max(PLAN_RANK[current] + 1, PLAN_RANK[required ?? "student"]);
  return (["student", "professional"] as const).filter((p) => PLAN_RANK[p] >= floor);
}
