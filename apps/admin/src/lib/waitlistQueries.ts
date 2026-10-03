import { supabase } from "@etymos/shared";
import type { AccessStatus, Profile } from "./types";
import type { PagedResult } from "./supabaseQueries";
import { PAGE_SIZE } from "./supabaseQueries";

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
