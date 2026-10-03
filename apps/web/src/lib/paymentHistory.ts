// The signed-in user's orders (checkout_events), for /account/payments.
// RLS (checkout_events_select_self_or_admin) already limits rows to the
// caller; the explicit user_id filter matches documentsQueries.ts.
import { supabase } from "@etymos/shared";

export type OrderState = "paid" | "awaiting" | "expired" | "cancelled" | "declined";

export interface HistoryOrder {
  id: string;
  kind: "plan" | "pack";
  plan_tier: "student" | "professional" | null;
  billing_cycle: "monthly" | "annual" | null;
  pack_id: "pack-standard" | "pack-premium" | null;
  quantity: number;
  amount: number;
  list_amount: number | null;
  paid_amount: number | null;
  status: "pending" | "success" | "declined" | "cancelled";
  payment_method: string | null;
  payment_code: string | null;
  created_at: string;
  expires_at: string | null;
  paid_at: string | null;
}

export async function fetchMyOrders(userId: string): Promise<HistoryOrder[]> {
  const { data, error } = await supabase
    .from("checkout_events")
    .select(
      "id, kind, plan_tier, billing_cycle, pack_id, quantity, amount, list_amount, paid_amount, status, payment_method, payment_code, created_at, expires_at, paid_at",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return ((data ?? []) as HistoryOrder[]).map((o) => ({
    ...o,
    amount: Number(o.amount ?? 0),
    list_amount: o.list_amount == null ? null : Number(o.list_amount),
    paid_amount: o.paid_amount == null ? null : Number(o.paid_amount),
    quantity: o.quantity ?? 1,
  }));
}

/** How an order reads to its owner. An unpaid order past its QR expiry is
 * "expired" (a late transfer would still be honoured). */
export function orderState(order: Pick<HistoryOrder, "status" | "expires_at">, now: number = Date.now()): OrderState {
  if (order.status === "success") return "paid";
  if (order.status === "cancelled") return "cancelled";
  if (order.status === "declined") return "declined";
  return order.expires_at && new Date(order.expires_at).getTime() <= now ? "expired" : "awaiting";
}

/** Total actually paid across paid orders. */
export function totalPaid(orders: Pick<HistoryOrder, "status" | "paid_amount" | "amount">[]): number {
  return orders.filter((o) => o.status === "success").reduce((sum, o) => sum + Number(o.paid_amount ?? o.amount ?? 0), 0);
}
