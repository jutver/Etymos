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
