// Query module for the current user's purchase requests (checkout_events).
//
// Modeled on configQueries.ts / documentsQueries.ts: plain async functions that
// throw on Supabase error, using the shared `@etymos/shared` client.
//
// There is no payment gateway. A user "paying" only ever writes a *pending*
// row here — `checkout_events_insert_self_pending` RLS enforces
// `user_id = auth.uid() and status = 'pending'`, and only an admin may UPDATE a
// row to 'success'/'declined' (`checkout_events_update_admin_only`). So nothing
// in this module ever touches `profiles` (plan_tier / standard_credits /
// premium_credits): granting access is entirely an admin-side action, and the
// web app learns about it on the next profile sync.
//
// Reads are explicitly scoped with `.eq("user_id", userId)` even though
// `checkout_events_select_self_or_admin` already restricts rows — same
// convention as documentsQueries.ts.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@etymos/shared";
import type {
  BillingCycle,
  CheckoutEventRow,
  CheckoutItem,
  CheckoutKind,
  CheckoutStatus,
  CreditPackId,
  PaymentMethod,
  PlanTier,
} from "@etymos/shared";
import { useAuth } from "./auth";

/** camelCase view model over a `checkout_events` row. */
export interface PurchaseRequest {
  id: string;
  kind: CheckoutKind;
  planTier: Exclude<PlanTier, "free"> | null;
  billingCycle: BillingCycle | null;
  packId: CreditPackId | null;
  amount: number | null;
  currency: string;
  paymentMethod: PaymentMethod | null;
  status: CheckoutStatus;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
}

function toPurchaseRequest(row: CheckoutEventRow): PurchaseRequest {
  return {
    id: row.id,
    kind: row.kind,
    planTier: row.plan_tier,
    billingCycle: row.billing_cycle,
    packId: row.pack_id,
    amount: row.amount != null ? Number(row.amount) : null,
    currency: row.currency,
    paymentMethod: row.payment_method,
    status: row.status,
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
    createdAt: row.created_at,
  };
}

export interface CreatePurchaseRequestInput {
  userId: string;
  /** The plan/pack the user picked, straight off the checkout flow. */
  item: CheckoutItem;
  /** Final price after any discount, in VND. Stored for the admin reviewer. */
  amount: number;
  paymentMethod: PaymentMethod;
}

/**
 * Inserts a `status: "pending"` checkout_events row for the user and returns
 * it. This is the *only* write the payment flow performs — the user's plan and
 * credit balances are untouched until an admin approves the row.
 */
export async function createPurchaseRequest(
  input: CreatePurchaseRequestInput,
): Promise<PurchaseRequest> {
  const { userId, item, amount, paymentMethod } = input;
  const { data, error } = await supabase
    .from("checkout_events")
    .insert({
      user_id: userId,
      kind: item.kind,
      plan_tier: item.kind === "plan" ? item.plan : null,
      billing_cycle: item.kind === "plan" ? item.billingCycle : null,
      pack_id: item.kind === "pack" ? item.packId : null,
      // numeric(10,2) — round so a discounted price never arrives as a long float.
      amount: Math.round(amount),
      currency: "VND",
      payment_method: paymentMethod,
      status: "pending",
    })
    .select("*")
    .single();
  if (error) throw error;
  return toPurchaseRequest(data as CheckoutEventRow);
}

/** Every request the user has ever made, newest first. */
export async function fetchMyRequests(userId: string): Promise<PurchaseRequest[]> {
  const { data, error } = await supabase
    .from("checkout_events")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as CheckoutEventRow[]).map(toPurchaseRequest);
}

/**
 * The user's most recent still-unreviewed request, or null. Used to show an
 * "awaiting approval" state and to stop a second request being queued while
 * one is outstanding.
 */
export async function fetchMyPendingRequest(userId: string): Promise<PurchaseRequest | null> {
  const { data, error } = await supabase
    .from("checkout_events")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? toPurchaseRequest(data as CheckoutEventRow) : null;
}

/** Human-readable summary of what was requested, for banners/receipts. */
export function describePurchaseRequest(request: PurchaseRequest): string {
  if (request.kind === "plan") {
    const tier = request.planTier === "professional" ? "Premium" : "Standard";
    const cycle = request.billingCycle === "annual" ? "annual" : "monthly";
    return `${tier} plan (${cycle})`;
  }
  return request.packId === "pack-premium" ? "Premium credit pack" : "Standard credit pack";
}

export interface PendingRequestState {
  pending: PurchaseRequest | null;
  loading: boolean;
  /** Re-reads from Supabase; call after submitting a new request. */
  refresh: () => void;
}

/**
 * Subscribes a screen to "does this user have an outstanding request?".
 * Deliberately local to this module rather than lib/store.ts — pending-request
 * state is server-owned (only an admin can clear it), so caching it in the
 * persisted zustand store would go stale after an approval.
 */
export function useMyPendingRequest(): PendingRequestState {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [pending, setPending] = useState<PurchaseRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!userId) {
      setPending(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchMyPendingRequest(userId)
      .then((row) => {
        if (!cancelled) setPending(row);
      })
      .catch((err: unknown) => {
        console.error("Failed to load pending purchase request", err);
        if (!cancelled) setPending(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, nonce]);

  return { pending, loading, refresh };
}
