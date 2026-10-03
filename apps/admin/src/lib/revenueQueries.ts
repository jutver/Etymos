// Money: paid orders (checkout_events) and the SePay bank-transfer ledger
// (payment_transactions). See supabase/migrations/20261004000000_sepay_payments.sql.
//
// Two numbers that sound alike but answer different questions:
//   * Revenue  — what paid orders were worth (status 'success'), counted on
//                the day they were paid. Includes orders an admin approved
//                by hand before automatic payments.
//   * Received — money that actually reached the bank account through SePay,
//                whether or not it matched an order. The gap between the two
//                is what the Transactions tab asks an admin to sort out.
import { supabase } from "@etymos/shared";
import type { PagedResult } from "./supabaseQueries";
import { PAGE_SIZE } from "./supabaseQueries";
import type { DailyPoint, DateRange } from "./dashboardQueries";

const FETCH_LIMIT = 5000;

export type TransactionStatus =
  | "matched"
  | "unmatched"
  | "underpaid"
  | "duplicate"
  | "review"
  | "ignored"
  | "resolved";

/** Transfers the webhook couldn't settle on its own. */
export const ATTENTION_STATUSES: TransactionStatus[] = ["unmatched", "underpaid", "duplicate", "review"];

export type OrderStatus = "pending" | "success" | "declined" | "cancelled";

interface OrderProfile {
  id: string;
  email: string | null;
  display_name: string | null;
}

export interface RevenueOrder {
  id: string;
  user_id: string;
  kind: "plan" | "pack";
  plan_tier: string | null;
  billing_cycle: string | null;
  pack_id: string | null;
  quantity: number | null;
  amount: number | null;
  list_amount: number | null;
  paid_amount: number | null;
  payment_method: string | null;
  payment_code: string | null;
  status: OrderStatus;
  expires_at: string | null;
  paid_at: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  profiles?: OrderProfile | null;
}

export interface PaymentTransaction {
  id: string;
  provider: string;
  provider_transaction_id: string;
  gateway: string | null;
  account_number: string | null;
  transfer_type: "in" | "out";
  amount: number;
  content: string | null;
  reference_code: string | null;
  payment_code: string | null;
  transaction_date: string | null;
  checkout_event_id: string | null;
  status: TransactionStatus;
  note: string | null;
  resolved_at: string | null;
  received_at: string;
  checkout_events?: Pick<RevenueOrder, "id" | "payment_code" | "kind" | "plan_tier" | "billing_cycle" | "pack_id" | "quantity" | "amount" | "user_id"> & {
    profiles?: OrderProfile | null;
  } | null;
}

const ORDER_PROFILE = "profiles!checkout_events_user_id_fkey(id, email, display_name)";

/* ------------------------------------------------------------------ */
/* Aggregation (pure, unit-tested)                                     */
/* ------------------------------------------------------------------ */

export interface ProductPoint {
  key: string;
  amount: number;
  count: number;
}

export interface RevenueSummary {
  revenue: number;
  paidOrders: number;
  averageOrder: number;
  /** Money in through SePay, matched or not. */
  received: number;
  revenueByDay: DailyPoint[];
  receivedByDay: DailyPoint[];
  /** Revenue split by what was bought, largest first. */
  byProduct: ProductPoint[];
  /** Revenue paid automatically (SePay) vs approved by hand. */
  automatic: number;
  manual: number;
}

/** What an order sold, as a stable key: "plan:professional:annual", "pack:pack-standard". */
export function productKey(order: Pick<RevenueOrder, "kind" | "plan_tier" | "billing_cycle" | "pack_id">): string {
  return order.kind === "plan"
    ? `plan:${order.plan_tier ?? "?"}:${order.billing_cycle ?? "monthly"}`
    : `pack:${order.pack_id ?? "?"}`;
}

/** Money an order brought in: what was actually paid, else its price. */
export function orderValue(order: Pick<RevenueOrder, "paid_amount" | "amount">): number {
  return Number(order.paid_amount ?? order.amount ?? 0);
}

/** The day an order counts towards: when it was paid, else when it was made. */
export function orderDay(order: Pick<RevenueOrder, "paid_at" | "reviewed_at" | "created_at">): string {
  return toLocalDay(order.paid_at ?? order.reviewed_at ?? order.created_at);
}

/** Calendar day in Vietnam time (UTC+7, no DST), where the business runs. */
export function toLocalDay(iso: string): string {
  return new Date(new Date(iso).getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

export function summarizeRevenue(
  orders: Pick<RevenueOrder, "kind" | "plan_tier" | "billing_cycle" | "pack_id" | "paid_amount" | "amount" | "paid_at" | "reviewed_at" | "created_at" | "payment_method">[],
  transactions: Pick<PaymentTransaction, "amount" | "transfer_type" | "transaction_date" | "received_at">[],
  days: string[],
): RevenueSummary {
  const revenueByDay = new Map(days.map((d) => [d, 0]));
  const receivedByDay = new Map(days.map((d) => [d, 0]));
  const products = new Map<string, ProductPoint>();
  let revenue = 0;
  let paidOrders = 0;
  let automatic = 0;
  let manual = 0;

  for (const order of orders) {
    const day = orderDay(order);
    if (!revenueByDay.has(day)) continue;
    const value = orderValue(order);
    revenue += value;
    paidOrders += 1;
    revenueByDay.set(day, (revenueByDay.get(day) ?? 0) + value);
    if (order.payment_method === "sepay") automatic += value;
    else manual += value;
    const key = productKey(order);
    const point = products.get(key) ?? { key, amount: 0, count: 0 };
    point.amount += value;
    point.count += 1;
    products.set(key, point);
  }

  let received = 0;
  for (const tx of transactions) {
    if (tx.transfer_type !== "in") continue;
    const day = toLocalDay(tx.transaction_date ?? tx.received_at);
    if (!receivedByDay.has(day)) continue;
    received += Number(tx.amount);
    receivedByDay.set(day, (receivedByDay.get(day) ?? 0) + Number(tx.amount));
  }

  return {
    revenue,
    paidOrders,
    averageOrder: paidOrders ? revenue / paidOrders : 0,
    received,
    revenueByDay: days.map((date) => ({ date, value: revenueByDay.get(date) ?? 0 })),
    receivedByDay: days.map((date) => ({ date, value: receivedByDay.get(date) ?? 0 })),
    byProduct: [...products.values()].sort((a, b) => b.amount - a.amount),
    automatic,
    manual,
  };
}

/** Days from start to end inclusive (yyyy-mm-dd). */
export function daysBetween(start: string, end: string): string[] {
  const days: string[] = [];
  const cur = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  while (cur <= last) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

/** UTC bounds of a range of Vietnam calendar days. */
export function rangeBoundsVN(range: DateRange): { gte: string; lte: string } {
  return {
    gte: new Date(`${range.start}T00:00:00.000+07:00`).toISOString(),
    lte: new Date(`${range.end}T23:59:59.999+07:00`).toISOString(),
  };
}

/** One CSV line; quotes every field so commas and quotes in transfer content are safe. */
export function csvRow(values: (string | number | null | undefined)[]): string {
  return values.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",");
}

/** Keeps a free-text search from breaking PostgREST's `or=(...)` syntax. */
export function cleanSearch(search: string): string {
  return search.replace(/[,()*%\\]/g, " ").trim();
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

export interface RevenueOverview extends RevenueSummary {
  /** Live counts, not range-scoped. */
  needsAttention: number;
  awaitingPayment: number;
  recentPayments: PaymentTransaction[];
}

export async function fetchRevenueOverview(range: DateRange): Promise<RevenueOverview> {
  const { gte, lte } = rangeBoundsVN(range);
  const nowIso = new Date().toISOString();

  const [ordersRes, txRes, attentionRes, awaitingRes, recentRes] = await Promise.all([
    supabase
      .from("checkout_events")
      .select("kind, plan_tier, billing_cycle, pack_id, amount, paid_amount, paid_at, reviewed_at, created_at, payment_method")
      .eq("status", "success")
      // Orders paid in range; older manual approvals have no paid_at, so
      // fall back to when they were made.
      .or(`and(paid_at.gte.${gte},paid_at.lte.${lte}),and(paid_at.is.null,created_at.gte.${gte},created_at.lte.${lte})`)
      .limit(FETCH_LIMIT),
    supabase
      .from("payment_transactions")
      .select("amount, transfer_type, transaction_date, received_at")
      .eq("transfer_type", "in")
      .gte("received_at", gte)
      .lte("received_at", lte)
      .limit(FETCH_LIMIT),
    supabase.from("payment_transactions").select("id", { count: "exact", head: true }).in("status", ATTENTION_STATUSES),
    supabase
      .from("checkout_events")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .eq("payment_method", "sepay")
      .gt("expires_at", nowIso),
    supabase
      .from("payment_transactions")
      .select(`*, checkout_events(id, payment_code, kind, plan_tier, billing_cycle, pack_id, quantity, amount, user_id, ${ORDER_PROFILE})`)
      .eq("transfer_type", "in")
      .order("received_at", { ascending: false })
      .limit(8),
  ]);

  for (const res of [ordersRes, txRes, attentionRes, awaitingRes, recentRes]) {
    if (res.error) throw res.error;
  }

  const summary = summarizeRevenue(
    (ordersRes.data ?? []) as RevenueOrder[],
    (txRes.data ?? []) as PaymentTransaction[],
    daysBetween(range.start, range.end),
  );
  return {
    ...summary,
    needsAttention: attentionRes.count ?? 0,
    awaitingPayment: awaitingRes.count ?? 0,
    recentPayments: (recentRes.data ?? []) as unknown as PaymentTransaction[],
  };
}

/** Every incoming transfer in the range as CSV, for bookkeeping. */
export async function exportTransactionsCsv(range: DateRange): Promise<string> {
  const { gte, lte } = rangeBoundsVN(range);
  const { data, error } = await supabase
    .from("payment_transactions")
    .select(`*, checkout_events(payment_code, ${ORDER_PROFILE})`)
    .gte("received_at", gte)
    .lte("received_at", lte)
    .order("received_at", { ascending: true })
    .limit(FETCH_LIMIT);
  if (error) throw error;
  const header = csvRow([
    "received_at", "transaction_date", "type", "amount_vnd", "status", "order_code", "customer_email",
    "transfer_content", "bank", "reference", "sepay_id", "note",
  ]);
  const lines = ((data ?? []) as unknown as PaymentTransaction[]).map((tx) =>
    csvRow([
      tx.received_at, tx.transaction_date, tx.transfer_type, tx.amount, tx.status,
      tx.checkout_events?.payment_code ?? tx.payment_code, tx.checkout_events?.profiles?.email,
      tx.content, tx.gateway, tx.reference_code, tx.provider_transaction_id, tx.note,
    ]),
  );
  return [header, ...lines].join("\n");
}

/* ------------------------------------------------------------------ */
/* Transactions                                                        */
/* ------------------------------------------------------------------ */

export type TransactionFilter = "attention" | "matched" | "resolved" | "ignored" | "all";

export async function listTransactions(
  page: number,
  search: string,
  filter: TransactionFilter,
): Promise<PagedResult<PaymentTransaction>> {
  const from = page * PAGE_SIZE;
  let query = supabase
    .from("payment_transactions")
    .select(
      `*, checkout_events(id, payment_code, kind, plan_tier, billing_cycle, pack_id, quantity, amount, user_id, ${ORDER_PROFILE})`,
      { count: "exact" },
    )
    .order("received_at", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);

  if (filter === "attention") query = query.in("status", ATTENTION_STATUSES);
  else if (filter !== "all") query = query.eq("status", filter);

  const term = cleanSearch(search);
  if (term) {
    query = query.or(`content.ilike.*${term}*,reference_code.ilike.*${term}*,payment_code.ilike.*${term}*`);
  }

  const { data, error, count } = await query;
  if (error) throw error;
  return { rows: (data ?? []) as unknown as PaymentTransaction[], count: count ?? 0 };
}

/** An order by its payment code, for linking a stray transfer to it. */
export async function findOrderByCode(code: string): Promise<RevenueOrder | null> {
  const term = code.trim().toUpperCase();
  if (!term) return null;
  const { data, error } = await supabase
    .from("checkout_events")
    .select(`*, ${ORDER_PROFILE}`)
    .eq("payment_code", term)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as RevenueOrder) ?? null;
}

/** Pays `orderId` with a transfer the webhook couldn't settle; grants it. */
export async function linkTransaction(transactionId: string, orderId: string, note: string): Promise<void> {
  const { error } = await supabase.rpc("admin_match_payment_transaction", {
    p_transaction_id: transactionId,
    p_event_id: orderId,
    p_note: note.trim() || null,
  });
  if (error) throw error;
}

/** Closes a transfer that needs no order (refunded, not a customer payment...). */
export async function resolveTransaction(transactionId: string, note: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("admin_resolve_payment_transaction", {
    p_transaction_id: transactionId,
    p_note: note,
  });
  if (error) throw error;
  return data === true;
}

/* ------------------------------------------------------------------ */
/* Orders                                                              */
/* ------------------------------------------------------------------ */

export type OrderFilter = "paid" | "awaiting" | "cancelled" | "declined" | "all";

export async function listOrders(page: number, search: string, filter: OrderFilter): Promise<PagedResult<RevenueOrder>> {
  const from = page * PAGE_SIZE;
  let query = supabase
    .from("checkout_events")
    .select(`*, ${ORDER_PROFILE}`, { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);

  if (filter === "paid") query = query.eq("status", "success");
  else if (filter === "awaiting") query = query.eq("status", "pending");
  else if (filter !== "all") query = query.eq("status", filter);

  const term = cleanSearch(search);
  if (term) query = query.ilike("payment_code", `*${term}*`);

  const { data, error, count } = await query;
  if (error) throw error;
  return { rows: (data ?? []) as unknown as RevenueOrder[], count: count ?? 0 };
}
