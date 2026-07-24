import { supabase } from "@etymos/shared";
import type { Profile } from "./types";

export const PAGE_SIZE = 20;

export interface PagedResult<T> {
  rows: T[];
  count: number;
}

/** Half-open [from, to) range of ISO timestamps, used to filter `created_at`
 * for the "signed up today / on a specific day" admin filter (CHANGES_I_WANT.md
 * Admin Portal #1). */
export interface DateRange {
  from: string;
  to: string;
}

export async function listProfiles(
  page: number,
  search: string,
  signupDateRange?: DateRange | null,
): Promise<PagedResult<Profile>> {
  const from = page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let query = supabase
    .from("profiles")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (search.trim()) {
    query = query.or(`email.ilike.%${search}%,display_name.ilike.%${search}%`);
  }

  if (signupDateRange) {
    query = query.gte("created_at", signupDateRange.from).lt("created_at", signupDateRange.to);
  }

  const { data, error, count } = await query;
  if (error) throw error;
  return { rows: (data ?? []) as Profile[], count: count ?? 0 };
}

export async function getProfile(id: string): Promise<Profile> {
  const { data, error } = await supabase.from("profiles").select("*").eq("id", id).single();
  if (error) throw error;
  return data as Profile;
}

export async function updateProfile(id: string, patch: Partial<Profile>): Promise<void> {
  const { error } = await supabase.from("profiles").update(patch).eq("id", id);
  if (error) throw error;
}

export interface AuditLogEntry {
  id: string;
  actor_id: string | null;
  target_user_id: string | null;
  action: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export async function listAuditLogForUser(userId: string): Promise<AuditLogEntry[]> {
  const { data, error } = await supabase
    .from("audit_log")
    .select("*")
    .eq("target_user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as AuditLogEntry[];
}

export interface NewAuditLogEntry {
  actor_id: string;
  target_user_id: string;
  action: string;
  metadata: Record<string, unknown>;
}

export async function insertAuditLog(entry: NewAuditLogEntry): Promise<void> {
  const { error } = await supabase.from("audit_log").insert(entry);
  if (error) throw error;
}
