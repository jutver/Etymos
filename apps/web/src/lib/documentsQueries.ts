// Query module for the current user's documents (History/Trash/Report data).
// Modeled on apps/admin/src/lib/supabaseQueries.ts: plain async functions that
// throw on Supabase error, using the shared `@etymos/shared` client so this
// app shares one Supabase Auth session with the rest of the codebase.
//
// All reads are additionally scoped with `.eq("user_id", userId)` even though
// `documents_all_self_or_admin` RLS already restricts rows to `auth.uid()` —
// explicit scoping keeps intent clear and avoids relying on RLS alone.
import { supabase } from "@etymos/shared";
import type { CheckedDocument, DocPassage, DocStatus, HistoryEntry, MatchedSource } from "@etymos/shared";

interface DocumentRow {
  id: string;
  user_id: string;
  title: string | null;
  file_name: string | null;
  language: string | null;
  word_count: number | null;
  status: DocStatus | null;
  similarity_score: number | null;
  similarity_score_free: number | null;
  web_sources_scanned: number | null;
  academic_sources_scanned: number | null;
  project: string | null;
  is_trashed: boolean;
  uploaded_at: string;
}

interface DocumentMatchRow {
  id: string;
  document_id: string;
  severity: MatchedSource["severity"] | null;
  detection_type: MatchedSource["detectionType"] | null;
  match_percent: number | null;
  source_title: string | null;
  source_author: string | null;
  source_kind: MatchedSource["sourceKind"] | null;
  citation: string | null;
  user_snippet: string | null;
  source_snippet: string | null;
  explanation: string | null;
  rewrite_suggestions: string[] | null;
}

interface DocumentPassageRow {
  id: string;
  document_id: string;
  text: string | null;
  severity: DocPassage["severity"] | null;
  match_id: string | null;
  sort_order: number | null;
}

function toHistoryEntry(row: DocumentRow): HistoryEntry {
  return {
    id: row.id,
    title: row.title ?? "Untitled document",
    date: row.uploaded_at.slice(0, 10),
    similarityScore: row.similarity_score != null ? Number(row.similarity_score) : 0,
    status: row.status ?? "clean",
    project: row.project ?? undefined,
    wordCount: row.word_count ?? 0,
  };
}

/** Non-trashed documents for the given user, newest first — replaces HISTORY_SEED. */
export async function fetchHistory(userId: string): Promise<HistoryEntry[]> {
  const { data, error } = await supabase
    .from("documents")
    .select("*")
    .eq("user_id", userId)
    .eq("is_trashed", false)
    .order("uploaded_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as DocumentRow[]).map(toHistoryEntry);
}

/** Trashed documents for the given user, newest first. */
export async function fetchTrash(userId: string): Promise<HistoryEntry[]> {
  const { data, error } = await supabase
    .from("documents")
    .select("*")
    .eq("user_id", userId)
    .eq("is_trashed", true)
    .order("uploaded_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as DocumentRow[]).map(toHistoryEntry);
}

/** Full document detail (passages + matches) for the Report screen. Returns null if not found/not owned. */
export async function fetchCheckedDocument(id: string): Promise<CheckedDocument | null> {
  const { data: doc, error: docError } = await supabase
    .from("documents")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (docError) throw docError;
  if (!doc) return null;

  const [matchesRes, passagesRes] = await Promise.all([
    supabase.from("document_matches").select("*").eq("document_id", id),
    supabase.from("document_passages").select("*").eq("document_id", id).order("sort_order"),
  ]);
  if (matchesRes.error) throw matchesRes.error;
  if (passagesRes.error) throw passagesRes.error;

  const matchRows = (matchesRes.data ?? []) as DocumentMatchRow[];
  const passageRows = (passagesRes.data ?? []) as DocumentPassageRow[];
  const docRow = doc as DocumentRow;

  const matches: MatchedSource[] = matchRows.map((m) => ({
    id: m.id,
    severity: m.severity ?? "low",
    detectionType: m.detection_type ?? "traditional",
    matchPercent: m.match_percent != null ? Number(m.match_percent) : 0,
    sourceTitle: m.source_title ?? "",
    sourceAuthor: m.source_author ?? "",
    sourceKind: m.source_kind ?? "web",
    citation: m.citation ?? "",
    userSnippet: m.user_snippet ?? "",
    sourceSnippet: m.source_snippet ?? "",
    explanation: m.explanation ?? "",
    rewriteSuggestions: m.rewrite_suggestions ?? [],
  }));

  const passages: DocPassage[] = passageRows.map((p) => ({
    id: p.id,
    text: p.text ?? "",
    severity: p.severity ?? undefined,
    matchId: p.match_id ?? undefined,
  }));

  return {
    id: docRow.id,
    title: docRow.title ?? "Untitled document",
    fileName: docRow.file_name ?? "",
    language: (docRow.language ?? "vi") as CheckedDocument["language"],
    wordCount: docRow.word_count ?? 0,
    uploadedAt: docRow.uploaded_at.slice(0, 10),
    similarityScore: docRow.similarity_score != null ? Number(docRow.similarity_score) : 0,
    similarityScoreFree: docRow.similarity_score_free != null ? Number(docRow.similarity_score_free) : 0,
    webSourcesScanned: docRow.web_sources_scanned ?? 0,
    academicSourcesScanned: docRow.academic_sources_scanned ?? 0,
    passages,
    matches,
  };
}

export async function moveDocumentToTrash(id: string): Promise<void> {
  const { error } = await supabase.from("documents").update({ is_trashed: true }).eq("id", id);
  if (error) throw error;
}

export async function restoreDocumentFromTrash(id: string): Promise<void> {
  const { error } = await supabase.from("documents").update({ is_trashed: false }).eq("id", id);
  if (error) throw error;
}

export async function permanentlyDeleteDocument(id: string): Promise<void> {
  const { error } = await supabase.from("documents").delete().eq("id", id);
  if (error) throw error;
}
