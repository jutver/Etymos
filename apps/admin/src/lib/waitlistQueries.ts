import { supabase } from "@etymos/shared";
import type { AccessStatus, BillingCycle, PlanTier, Profile } from "./types";
import type { PagedResult } from "./supabaseQueries";
import { PAGE_SIZE } from "./supabaseQueries";

export type PurchaseStatus = "pending" | "success" | "declined";
export type CheckoutKind = "plan" | "pack";

/** A checkout_events row plus the requesting user's profile, for the
 * Waitlist → Purchases review queue. */
export interface PurchaseRequest {
  id: string;
  user_id: string;
  kind: CheckoutKind;
  plan_tier: PlanTier | null;
  billing_cycle: BillingCycle | null;
  pack_id: string | null;
  amount: number;
  currency: string | null;
  payment_method: string | null;
  status: PurchaseStatus;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_note: string | null;
  created_at: string;
  profiles?: Pick<Profile, "id" | "email" | "display_name"> | null;
}

/* ------------------------------------------------------------------ */
/* App-access requests (profiles.access_status)                        */
/* ------------------------------------------------------------------ */

export async function listAccessRequests(
  page: number,
  search: string,
  status: AccessStatus | "all" = "waitlisted",
): Promise<PagedResult<Profile>> {
  const from = page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let query = supabase
    .from("profiles")
    .select("*", { count: "exact" })
    // Oldest-first while triaging the queue (fair FIFO), newest-first once
    // looking at already-reviewed rows.
    .order("created_at", { ascending: status === "waitlisted" })
    .range(from, to);

  if (status !== "all") {
    query = query.eq("access_status", status);
  }

  if (search.trim()) {
    query = query.or(`email.ilike.%${search}%,display_name.ilike.%${search}%`);
  }

  const { data, error, count } = await query;
  if (error) throw error;
  return { rows: (data ?? []) as unknown as Profile[], count: count ?? 0 };
}

async function setAccessStatus(
  userId: string,
  status: Exclude<AccessStatus, "waitlisted">,
  adminId: string,
  note: string,
): Promise<void> {
  const { error } = await supabase
    .from("profiles")
    .update({
      access_status: status,
      access_reviewed_at: new Date().toISOString(),
      access_reviewed_by: adminId,
      access_note: note.trim() || null,
    })
    .eq("id", userId);
  if (error) throw error;
}

export async function approveAccess(userId: string, adminId: string, note = ""): Promise<void> {
  await setAccessStatus(userId, "approved", adminId, note);
}

export async function rejectAccess(userId: string, adminId: string, note = ""): Promise<void> {
  await setAccessStatus(userId, "rejected", adminId, note);
}

/* ------------------------------------------------------------------ */
/* Purchase requests (checkout_events)                                 */
/* ------------------------------------------------------------------ */

export async function listPurchaseRequests(
  page: number,
  search: string,
  status: PurchaseStatus | "all" = "pending",
): Promise<PagedResult<PurchaseRequest>> {
  const from = page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let query = supabase
    .from("checkout_events")
    // checkout_events has two FKs to profiles (user_id, reviewed_by); the
    // embed must be disambiguated with the constraint name or PostgREST
    // returns PGRST201 "more than one relationship was found".
    .select("*, profiles!checkout_events_user_id_fkey(id, email, display_name)", { count: "exact" })
    .order("created_at", { ascending: status === "pending" })
    .range(from, to);

  if (status !== "all") {
    query = query.eq("status", status);
  }

  if (search.trim()) {
    query = query.or(`plan_tier.ilike.%${search}%,pack_id.ilike.%${search}%`);
  }

  const { data, error, count } = await query;
  if (error) throw error;
  return { rows: (data ?? []) as unknown as PurchaseRequest[], count: count ?? 0 };
}

// Entitlement application (which balance a pack tops up, resetting the plan
// period, reading credit_packs.checks so repricing flows through) lives in the
// approve_purchase_request SQL function — see
// 20260721000200_approve_purchase_atomic.sql. It has to run in the same
// transaction as the status flip, which is not something a client can express.

async function reviewPurchase(
  id: string,
  status: Exclude<PurchaseStatus, "pending">,
  adminId: string,
  note: string,
): Promise<void> {
  const { error } = await supabase
    .from("checkout_events")
    .update({
      status,
      reviewed_at: new Date().toISOString(),
      reviewed_by: adminId,
      review_note: note.trim() || null,
    })
    .eq("id", id);
  if (error) throw error;
}

/** Grants the entitlement and marks the event `success` in one transaction.
 *
 * This deliberately does NOT do the work client-side. Granting and marking as
 * two sequential calls leaves a double-credit hole: if the grant succeeds and
 * the status update fails, the row stays `pending`, the admin retries, and the
 * user is credited twice. The RPC takes a row lock and no-ops on an event that
 * is no longer pending, so retries are safe.
 *
 * Returns false when the event was already reviewed by someone else — the
 * caller should refresh rather than treat it as an error. */
export async function approvePurchase(row: PurchaseRequest, note = ""): Promise<boolean> {
  const { data, error } = await supabase.rpc("approve_purchase_request", {
    p_event_id: row.id,
    p_note: note,
  });
  if (error) throw error;
  return data === true;
}

export async function declinePurchase(id: string, adminId: string, note = ""): Promise<void> {
  await reviewPurchase(id, "declined", adminId, note);
}
