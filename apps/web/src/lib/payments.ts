// Small, pure helpers for the SePay checkout (screens/Checkout,
// screens/PaymentSuccess). The network calls live in lib/api.ts.
import type { CheckoutItem } from "@etymos/shared";
import { ApiError, type PaymentItem, type PaymentOrder } from "./api";
import { t } from "./i18n";

/** The body the backend prices/orders. Quantity only applies to packs. */
export function toPaymentItem(item: CheckoutItem, quantity: number): PaymentItem {
  return item.kind === "plan"
    ? { kind: "plan", plan_tier: item.plan, billing_cycle: item.billingCycle }
    : { kind: "pack", pack_id: item.packId, quantity };
}

/** Whether an existing order is for the item the user is checking out now. */
export function orderMatches(order: PaymentOrder, item: CheckoutItem): boolean {
  if (item.kind === "plan") {
    return order.kind === "plan" && order.plan_tier === item.plan && order.billing_cycle === item.billingCycle;
  }
  return order.kind === "pack" && order.pack_id === item.packId;
}

export function isDiscountError(err: unknown): boolean {
  return err instanceof ApiError && err.message.startsWith("discount_");
}

/** User-facing text for a payments API error. */
export function paymentErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.message) {
      case "discount_invalid":
        return t("Invalid discount code.");
      case "discount_inactive":
        return t("This discount code is no longer active.");
      case "discount_not_started":
        return t("This discount code is not active yet.");
      case "discount_expired":
        return t("This discount code has expired.");
      case "discount_limit_reached":
        return t("This discount code has reached its usage limit.");
      case "discount_already_used":
        return t("You have already used this discount code.");
      case "verification_required":
        return t("Verify your student status before buying this plan.");
      case "payments_not_configured":
        return t("Payments aren't available right now. Please try again later.");
      default:
        if (err.status === 429) return t("Too many requests. Please wait a minute and try again.");
        return err.message;
    }
  }
  return err instanceof Error ? err.message : t("Something went wrong.");
}

/** "Premium plan (annual)", "Standard credit pack ×3", ... */
export function describeOrder(order: Pick<PaymentOrder, "kind" | "plan_tier" | "billing_cycle" | "pack_id" | "quantity">): string {
  if (order.kind === "plan") {
    const tier = order.plan_tier === "professional" ? t("Premium") : t("Standard");
    const cycle = order.billing_cycle === "annual" ? t("annual") : t("monthly");
    return t("{{tier}} plan ({{cycle}})", { tier, cycle });
  }
  const label = order.pack_id === "pack-premium" ? t("Premium credit pack") : t("Standard credit pack");
  return order.quantity > 1 ? `${label} ×${order.quantity}` : label;
}

/** "m:ss" left until `expiresAt`, or null once it has passed (or there is none). */
export function timeLeft(expiresAt: string | null, now: number): string | null {
  if (!expiresAt) return null;
  const seconds = Math.ceil((new Date(expiresAt).getTime() - now) / 1000);
  if (seconds <= 0) return null;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* Subscription terms (supabase/migrations/20261005000000_plan_expiry.sql) */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;
/** "Ending soon" from this many days before the end. */
export const EXPIRY_WARNING_DAYS = 7;

export type SubscriptionStatus =
  | { kind: "free"; endedAt: string | null }
  | { kind: "no_end" }
  | { kind: "active" | "ending_soon"; endsAt: string; daysLeft: number };

/** Where the account's plan stands. `plan` is already the effective plan
 * (lib/profileQueries reads a lapsed plan as "free"). */
export function subscriptionStatus(plan: string, planExpiresAt: string | null, now: number = Date.now()): SubscriptionStatus {
  if (plan === "free") {
    const ended = planExpiresAt && new Date(planExpiresAt).getTime() <= now ? planExpiresAt : null;
    return { kind: "free", endedAt: ended };
  }
  if (!planExpiresAt) return { kind: "no_end" };
  const daysLeft = Math.max(0, Math.ceil((new Date(planExpiresAt).getTime() - now) / DAY_MS));
  return { kind: daysLeft <= EXPIRY_WARNING_DAYS ? "ending_soon" : "active", endsAt: planExpiresAt, daysLeft };
}

/** One term after `from`, matching Postgres `+ interval '1 month' / '1 year'`
 * (calendar months, clamped to the month's last day). */
export function addTerm(from: Date, cycle: "monthly" | "annual"): Date {
  const d = new Date(from);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  if (cycle === "annual") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

export type PlanPurchaseEffect =
  | { kind: "start"; endsAt: Date }
  | { kind: "renew"; endsAt: Date }
  | { kind: "replace"; currentPlan: string; currentEndsAt: string | null; endsAt: Date };

/** What buying `item` does to the current plan — same rules as
 * grant_checkout_entitlement: the same active plan is extended from its end
 * date; a different paid plan is replaced from now. */
export function planPurchaseEffect(
  currentPlan: string,
  currentExpiresAt: string | null,
  item: { plan: string; billingCycle: "monthly" | "annual" },
  now: number = Date.now(),
): PlanPurchaseEffect {
  const fromNow = addTerm(new Date(now), item.billingCycle);
  if (currentPlan === "free") return { kind: "start", endsAt: fromNow };
  if (currentPlan === item.plan) {
    return currentExpiresAt && new Date(currentExpiresAt).getTime() > now
      ? { kind: "renew", endsAt: addTerm(new Date(currentExpiresAt), item.billingCycle) }
      : { kind: "start", endsAt: fromNow };
  }
  return { kind: "replace", currentPlan, currentEndsAt: currentExpiresAt, endsAt: fromNow };
}
