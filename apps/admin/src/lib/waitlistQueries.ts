import { supabase } from "@etymos/shared";
import type { AccessStatus, Profile } from "./types";
import type { PagedResult } from "./supabaseQueries";
import { PAGE_SIZE } from "./supabaseQueries";
import { tr } from "./i18n";

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
/* Auto-approve (feature_flags.waitlist_auto_approve)                  */
/* ------------------------------------------------------------------ */

/** The note handle_new_user and admin_set_waitlist_auto_approve stamp on
 * accounts let in by auto-approve (supabase/migrations/20261029000000). */
export const AUTO_APPROVED_NOTE = tr("Auto-approved");

export async function getAutoApprove(): Promise<boolean> {
  const { data, error } = await supabase
    .from("feature_flags")
    .select("enabled")
    .eq("key", "waitlist_auto_approve")
    .maybeSingle();
  if (error) throw error;
  return data?.enabled ?? false;
}

export async function countWaitlisted(): Promise<number> {
  const { count, error } = await supabase
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("access_status", "waitlisted");
  if (error) throw error;
  return count ?? 0;
}

/** Turning it on also approves everyone waiting; returns how many. */
export async function setAutoApprove(enabled: boolean): Promise<number> {
  const { data, error } = await supabase.rpc("admin_set_waitlist_auto_approve", { p_enabled: enabled });
  if (error) throw error;
  return (data as number | null) ?? 0;
}
