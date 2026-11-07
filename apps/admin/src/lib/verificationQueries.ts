import { supabase } from "@etymos/shared";
import type { Profile } from "./types";
import type { PagedResult } from "./supabaseQueries";
import { PAGE_SIZE } from "./supabaseQueries";
import { tr } from "./i18n";
import { deleteRecordsWithFiles, type DeleteResult, type DeleteScope } from "./storageFiles";

export type VerificationStatus = "pending" | "approved" | "rejected";

export interface VerificationRequest {
  id: string;
  user_id: string;
  storage_path: string;
  status: VerificationStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  /** Set once an admin deleted the evidence file; the request stays. */
  file_deleted_at: string | null;
  file_deleted_by: string | null;
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

/** Approves a pending request, or a rejected one on second thought. */
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

/** Deletes requests and their evidence files. The student keeps their
 * verified status: it lives on the profile, not on the request. */
export function deleteVerificationRequests(scope: DeleteScope): Promise<DeleteResult> {
  return deleteRecordsWithFiles("admin_delete_verification_requests", EVIDENCE_BUCKET, scope);
}

/** Deletes the evidence files of these requests but keeps the requests,
 * marked with when and by whom. The files go first, so a request is only
 * marked once its file is really gone; a retry after a failure is safe
 * (removing a file that's already gone is not an error). */
export async function deleteVerificationFiles(rows: VerificationRequest[], adminId: string): Promise<number> {
  const pending = rows.filter((r) => !r.file_deleted_at);
  if (pending.length === 0) return 0;
  const { error: storageError } = await supabase.storage
    .from(EVIDENCE_BUCKET)
    .remove(pending.map((r) => r.storage_path));
  if (storageError) throw storageError;
  const { error } = await supabase
    .from("student_verification_requests")
    .update({ file_deleted_at: new Date().toISOString(), file_deleted_by: adminId })
    .in(
      "id",
      pending.map((r) => r.id),
    );
  if (error) throw error;
  return pending.length;
}
