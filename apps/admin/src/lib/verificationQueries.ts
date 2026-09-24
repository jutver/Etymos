import { supabase } from "@etymos/shared";
import type { Profile } from "./types";
import type { PagedResult } from "./supabaseQueries";
import { PAGE_SIZE } from "./supabaseQueries";
import { tr } from "./i18n";

export type VerificationStatus = "pending" | "approved" | "rejected";

export interface VerificationRequest {
  id: string;
  user_id: string;
  storage_path: string;
  status: VerificationStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  profiles?: Pick<Profile, "id" | "email" | "display_name"> | null;
}

const EVIDENCE_BUCKET = "student-verification";

export async function listVerificationRequests(
  page: number,
  search: string,
  status: VerificationStatus | "all" = "pending",
): Promise<PagedResult<VerificationRequest>> {
  const from = page * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let query = supabase
    .from("student_verification_requests")
    // student_verification_requests has two FKs to profiles (user_id,
    // reviewed_by); the embed must be disambiguated with the constraint
    // name or PostgREST returns PGRST201 "more than one relationship".
    .select("*, profiles!student_verification_requests_user_id_fkey(id, email, display_name)", { count: "exact" })
    .order("created_at", { ascending: status === "pending" })
    .range(from, to);

  if (status !== "all") {
    query = query.eq("status", status);
  }

  if (search.trim()) {
    query = query.ilike("storage_path", `%${search}%`);
  }

  const { data, error, count } = await query;
  if (error) throw error;
  return { rows: (data ?? []) as unknown as VerificationRequest[], count: count ?? 0 };
}

export async function approveVerificationRequest(
  id: string,
  userId: string,
  adminId: string,
): Promise<void> {
  const { error: requestError } = await supabase
    .from("student_verification_requests")
    .update({
      status: "approved",
      reviewed_by: adminId,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (requestError) throw requestError;

  const { error: profileError } = await supabase
    .from("profiles")
    .update({ student_verified: true })
    .eq("id", userId);
  if (profileError) throw profileError;
}

export async function rejectVerificationRequest(id: string, adminId: string): Promise<void> {
  const { error } = await supabase
    .from("student_verification_requests")
    .update({
      status: "rejected",
      reviewed_by: adminId,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw error;
}

export async function getEvidenceSignedUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from(EVIDENCE_BUCKET)
    .createSignedUrl(storagePath, 300);
  if (error) throw error;
  if (!data?.signedUrl) throw new Error(tr("Could not generate a preview link for this file."));
  return data.signedUrl;
}
