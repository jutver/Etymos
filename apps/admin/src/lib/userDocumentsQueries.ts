// The Documents tab of a user's page: every document the account has, with
// its scores and how many times it was re-checked. Admins can read both
// tables through documents_all_self_or_admin and document_checks_select_self_or_admin.
import { supabase } from "@etymos/shared";
import type { DocStatus, ModerationStatus } from "./types";

export interface UserDocument {
  id: string;
  title: string | null;
  file_name: string | null;
  language: string | null;
  word_count: number | null;
  status: DocStatus | null;
  similarity_score: number | null;
  /** ai_detection.overall_score; null when detection didn't run. */
  ai_score: number | null;
  /** Re-checks after the upload (document_checks rows other than the upload). */
  rechecks: number;
  moderation_status: ModerationStatus;
  is_trashed: boolean;
  uploaded_at: string;
}

/** Enough for one account; the tab pages and sums them in the browser. */
const LIMIT = 1000;

interface Row extends Omit<UserDocument, "ai_score" | "rechecks" | "similarity_score"> {
  similarity_score: number | string | null;
  ai_score: number | string | null;
  document_checks: { kind: string }[] | null;
}

function num(value: number | string | null): number | null {
  if (value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function listUserDocuments(userId: string): Promise<UserDocument[]> {
  const { data, error } = await supabase
    .from("documents")
    .select(
      "id, title, file_name, language, word_count, status, similarity_score, ai_score:ai_detection->overall_score, moderation_status, is_trashed, uploaded_at, document_checks(kind)",
    )
    .eq("user_id", userId)
    .order("uploaded_at", { ascending: false })
    .limit(LIMIT);
  if (error) throw error;
  return ((data ?? []) as unknown as Row[]).map(({ document_checks, ...row }) => ({
    ...row,
    similarity_score: num(row.similarity_score),
    ai_score: num(row.ai_score),
    rechecks: (document_checks ?? []).filter((c) => c.kind !== "upload").length,
  }));
}

/** How many documents the account has, for the page header. */
export async function countUserDocuments(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from("documents")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (error) throw error;
  return count ?? 0;
}

export interface UserDocumentSummary {
  total: number;
  averageSimilarity: number | null;
  highestSimilarity: number | null;
  /** Upload checks plus re-checks. */
  checks: number;
  flagged: number;
}

export function summarizeUserDocuments(docs: UserDocument[]): UserDocumentSummary {
  const scored = docs.map((d) => d.similarity_score).filter((s): s is number => s !== null);
  return {
    total: docs.length,
    averageSimilarity: scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null,
    highestSimilarity: scored.length ? Math.max(...scored) : null,
    checks: scored.length + docs.reduce((n, d) => n + d.rechecks, 0),
    flagged: docs.filter((d) => d.moderation_status === "flagged").length,
  };
}
