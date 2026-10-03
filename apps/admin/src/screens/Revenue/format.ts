import type { OrderStatus, RevenueOrder, TransactionStatus } from "../../lib/revenueQueries";
import { t, tr } from "../../lib/i18n";

export type BadgeTone = "neutral" | "accent" | "destructive" | "warning" | "info" | "success";

export function formatVND(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return "—";
  return new Intl.NumberFormat("vi-VN").format(Math.round(Number(amount))) + " đ";
}

/** Short VND for chart axes: 1.2M, 350K. */
export function formatCompactVND(amount: number): string {
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(amount >= 10_000_000 ? 0 : 1)}M`;
  if (amount >= 1_000) return `${Math.round(amount / 1_000)}K`;
  return String(amount);
}

const TIER_LABELS: Record<string, string> = {
  student: tr("Student"),
  professional: tr("Professional"),
};

const PACK_LABELS: Record<string, string> = {
  "pack-standard": tr("Standard pack"),
  "pack-premium": tr("Premium pack"),
};

const CYCLE_LABELS: Record<string, string> = {
  monthly: tr("monthly"),
  annual: tr("annual"),
};

/** "Professional plan · annual", "Standard pack ×3". */
export function describeItem(
  order: Pick<RevenueOrder, "kind" | "plan_tier" | "billing_cycle" | "pack_id" | "quantity">,
): string {
  if (order.kind === "plan") {
    const tier = t(TIER_LABELS[order.plan_tier ?? ""] ?? order.plan_tier ?? "—");
    const cycle = order.billing_cycle ? ` · ${t(CYCLE_LABELS[order.billing_cycle] ?? order.billing_cycle)}` : "";
    return t("{{tier}} plan", { tier }) + cycle;
  }
  const label = t(PACK_LABELS[order.pack_id ?? ""] ?? order.pack_id ?? "—");
  const qty = order.quantity ?? 1;
  return qty > 1 ? `${label} ×${qty}` : label;
}

/** Same, from a summarizeRevenue product key ("plan:professional:annual", "pack:pack-standard"). */
export function describeProductKey(key: string): string {
  const [kind, a, b] = key.split(":");
  return kind === "plan"
    ? describeItem({ kind: "plan", plan_tier: a ?? null, billing_cycle: b ?? null, pack_id: null, quantity: 1 })
    : describeItem({ kind: "pack", plan_tier: null, billing_cycle: null, pack_id: a ?? null, quantity: 1 });
}

export const TRANSACTION_STATUS_LABELS: Record<TransactionStatus, string> = {
  matched: tr("Matched"),
  unmatched: tr("Unmatched"),
  underpaid: tr("Underpaid"),
  duplicate: tr("Paid twice"),
  review: tr("Needs review"),
  ignored: tr("Outgoing"),
  resolved: tr("Resolved"),
};

export function transactionTone(status: TransactionStatus): BadgeTone {
  if (status === "matched") return "success";
  if (status === "resolved" || status === "ignored") return "neutral";
  if (status === "underpaid" || status === "duplicate") return "destructive";
  return "warning";
}

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  success: tr("Paid"),
  pending: tr("Awaiting payment"),
  cancelled: tr("Cancelled"),
  declined: tr("Declined"),
};

export function orderTone(order: Pick<RevenueOrder, "status" | "payment_method">): BadgeTone {
  if (order.status === "success") return "success";
  if (order.status === "declined") return "destructive";
  if (order.status === "cancelled") return "neutral";
  return order.payment_method === "sepay" ? "info" : "warning";
}

/** "Bank transfer" for SePay orders, the wallet name for older manual ones. */
export function methodLabel(method: string | null): string {
  if (method === "sepay") return t("Bank transfer");
  if (!method) return "—";
  return method === "vnpay" ? "VNPay" : method === "momo" ? "MoMo" : method === "zalopay" ? "ZaloPay" : method;
}

export function formatDateTime(iso: string | null | undefined, locale: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });
}
