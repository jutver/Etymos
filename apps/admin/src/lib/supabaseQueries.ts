import { supabase } from "@etymos/shared";
import { ONLINE_THRESHOLD_MS, type AccessStatus, type AdminRole, type PlanTier, type Profile } from "./types";

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

export type UserSort = "newest" | "oldest" | "last_seen" | "credits";
export type UserActivityFilter = "" | "online" | "banned" | "deletion";

/** Filters for the admin Users list. Empty string = "any" for every enum field. */
export interface ProfileFilters {
  search: string;
  signupDateRange?: DateRange | null;
  role?: AdminRole | "";
  plan?: PlanTier | "";
  access?: AccessStatus | "";
  verified?: "" | "yes" | "no";
  activity?: UserActivityFilter;
  sort?: UserSort;
}

/** PostgREST `or()` filters are comma/paren-delimited, so a stray `,` or `(`
 * in the search box would break the query — strip them (and the `%`/`*`
 * wildcards) before interpolating. */
export function sanitizeSearch(search: string): string {
  return search.trim().replace(/[,()%*\\]/g, " ").trim();
}

export async function listProfiles(page: number, filters: ProfileFilters): Promise<PagedResult<Profile>> {
  const from = page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let query = supabase.from("profiles").select("*", { count: "exact" });

  switch (filters.sort ?? "newest") {
    case "oldest":
      query = query.order("created_at", { ascending: true });
      break;
    case "last_seen":
      query = query.order("last_seen_at", { ascending: false, nullsFirst: false });
      break;
    case "credits":
      query = query.order("premium_credits", { ascending: false }).order("standard_credits", { ascending: false });
      break;
    default:
      query = query.order("created_at", { ascending: false });
  }
  query = query.range(from, to);

  const search = sanitizeSearch(filters.search);
  if (search) {
    query = query.or(`email.ilike.%${search}%,display_name.ilike.%${search}%`);
  }

  if (filters.signupDateRange) {
    query = query.gte("created_at", filters.signupDateRange.from).lt("created_at", filters.signupDateRange.to);
  }

  if (filters.role) query = query.eq("role", filters.role);
  if (filters.plan) query = query.eq("plan_tier", filters.plan);
  if (filters.access) query = query.eq("access_status", filters.access);
  if (filters.verified) query = query.eq("student_verified", filters.verified === "yes");

  const now = new Date();
  switch (filters.activity) {
    case "online":
      // Same threshold as isProfileOnline() so the filter agrees with the dot.
      query = query.gte("last_seen_at", new Date(now.getTime() - ONLINE_THRESHOLD_MS).toISOString());
      break;
    case "banned":
      // Same rule as isProfileBanned(): permanent, or a temporary ban still running.
      query = query.or(`banned_permanent.eq.true,banned_until.gt.${now.toISOString()}`);
      break;
    case "deletion":
      query = query.not("deletion_requested_at", "is", null);
      break;
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
