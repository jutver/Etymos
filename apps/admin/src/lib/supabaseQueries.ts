import { supabase } from "@etymos/shared";
import type { Profile } from "./types";

export const PAGE_SIZE = 20;

export interface PagedResult<T> {
  rows: T[];
  count: number;
}

export async function listProfiles(page: number, search: string): Promise<PagedResult<Profile>> {
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
