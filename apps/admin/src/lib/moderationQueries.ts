import { supabase } from "@etymos/shared";
import type { AdminDocument, ModerationStatus } from "./types";
import type { PagedResult } from "./supabaseQueries";
import { PAGE_SIZE } from "./supabaseQueries";

export async function listDocuments(page: number, search: string): Promise<PagedResult<AdminDocument>> {
  const from = page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let query = supabase
    .from("documents")
    .select("*, profiles(id, email, display_name)", { count: "exact" })
    .order("uploaded_at", { ascending: false })
    .range(from, to);

  if (search.trim()) {
    query = query.ilike("title", `%${search}%`);
  }

  const { data, error, count } = await query;
  if (error) throw error;
  return { rows: (data ?? []) as unknown as AdminDocument[], count: count ?? 0 };
}

export async function getDocument(id: string): Promise<AdminDocument> {
  const { data, error } = await supabase
    .from("documents")
    .select("*, profiles(id, email, display_name)")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data as unknown as AdminDocument;
}

export async function setModerationStatus(
  id: string,
  status: ModerationStatus,
  notes: string,
  adminId: string,
): Promise<void> {
  const { error } = await supabase
    .from("documents")
    .update({
      moderation_status: status,
      moderation_notes: notes || null,
      flagged_at: status === "none" ? null : new Date().toISOString(),
      flagged_by: status === "none" ? null : adminId,
    })
    .eq("id", id);
  if (error) throw error;
}
