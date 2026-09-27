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
import type { DocumentVersion } from "../screens/Report/VersionHistoryMenu";
import { parseAiDetection } from "./aiDetection";
import { parseExplanationFacts } from "./matchExplanation";
import { tr } from "./i18n";

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
  // Added by supabase/migrations/20260721000100_document_checking_status.sql.
  // Nullable in the type (not the schema) so rows selected before the
  // migration is applied still parse instead of throwing.
  check_state?: CheckState | null;
  check_job_id?: string | null;
  check_error?: string | null;
  // Added by supabase/migrations/20260727000100_documents_ai_detection.sql.
  // Optional in the type so rows read before that migration is applied still parse.
  ai_detection?: unknown;
}

/** Lifecycle of the *analysis job*, orthogonal to `status` (which is the
 * similarity severity and only exists once a check has completed). */
export type CheckState = "checking" | "completed" | "failed";

/** A history row that also knows whether its check is still running. Extends
 * the shared `HistoryEntry` so every existing consumer keeps typechecking. */
export interface HistoryEntryWithCheck extends HistoryEntry {
  checkState: CheckState;
  checkJobId?: string;
  checkError?: string;
  /** Raw `uploaded_at`, used to age out jobs the backend forgot about. */
  startedAt: string;
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
  // Added by supabase/migrations/20260928000000_document_match_explanation_facts.sql.
  explanation_facts?: unknown;
  source_url?: string | null;
  source_year?: string | null;
  source_doi?: string | null;
}

interface DocumentPassageRow {
  id: string;
  document_id: string;
  text: string | null;
  severity: DocPassage["severity"] | null;
  match_id: string | null;
  sort_order: number | null;
  // Added by supabase/migrations/20260724020000_document_passage_structure.sql.
  // All nullable — older rows (and reports saved before this shipped) have
  // these as null, which maps to the corresponding DocPassage field being
  // `undefined` (see the mapping below).
  block_type: DocPassage["blockType"] | null;
  level: DocPassage["level"] | null;
  list_type: DocPassage["listType"] | null;
  page: number | null;
  table_rows: string[][] | null;
  // Added by supabase/migrations/20260725000000_document_passage_image_url.sql.
  image_url: string | null;
  // Added by supabase/migrations/20260927000000_document_passage_text_marks.sql.
  // Optional: absent until that migration is applied.
  text_marks?: DocPassage["textMarks"] | null;
}

function toHistoryEntry(row: DocumentRow): HistoryEntryWithCheck {
  return {
    id: row.id,
    title: row.title ?? tr("Untitled document"),
    fileName: row.file_name ?? undefined,
    date: row.uploaded_at.slice(0, 10),
    similarityScore: row.similarity_score != null ? Number(row.similarity_score) : 0,
    status: row.status ?? "clean",
    project: row.project ?? undefined,
    wordCount: row.word_count ?? 0,
    checkState: row.check_state ?? "completed",
    checkJobId: row.check_job_id ?? undefined,
    checkError: row.check_error ?? undefined,
    startedAt: row.uploaded_at,
  };
}

/** Non-trashed documents for the given user, newest first — replaces HISTORY_SEED. */
export async function fetchHistory(userId: string): Promise<HistoryEntryWithCheck[]> {
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
export async function fetchTrash(userId: string): Promise<HistoryEntryWithCheck[]> {
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
    explanationFacts: parseExplanationFacts(m.explanation_facts),
    sourceUrl: m.source_url || undefined,
    sourceYear: m.source_year || undefined,
    sourceDoi: m.source_doi || undefined,
  }));

  const passages: DocPassage[] = passageRows.map((p) => ({
    id: p.id,
    text: p.text ?? "",
    severity: p.severity ?? undefined,
    matchId: p.match_id ?? undefined,
    blockType: p.block_type ?? undefined,
    level: p.level ?? undefined,
    listType: p.list_type ?? undefined,
    page: p.page ?? undefined,
    tableRows: p.table_rows ?? undefined,
    imageUrl: p.image_url ?? undefined,
    textMarks: p.text_marks ?? undefined,
  }));

  return {
    id: docRow.id,
    title: docRow.title ?? tr("Untitled document"),
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
    aiDetection: parseAiDetection(docRow.ai_detection),
  };
}

// --- In-flight check lifecycle ---------------------------------------------
// A check used to become visible only once the backend had finished and
// `save_report()` upserted a `documents` row keyed by its report_id. The web
// app now inserts its own placeholder row up front (check_state='checking') so
// the document shows in Documents/History while it runs, survives a reload,
// and cannot be lost by navigating away from the Analyzing screen.

/** Inserts the placeholder row for a check the user just started. Called
 * *before* the upload request completes, so the job appears in the list
 * immediately; `attachCheckJobId` fills in the backend job id once known. */
export async function createCheckingDocument(params: {
  userId: string;
  title: string;
  fileName: string | null;
  language: string;
  project: string | null;
}): Promise<HistoryEntryWithCheck> {
  const { data, error } = await supabase
    .from("documents")
    .insert({
      user_id: params.userId,
      title: params.title,
      file_name: params.fileName,
      language: params.language,
      project: params.project,
      check_state: "checking",
      // `status`/`similarity_score` stay null until the analysis produces them.
    })
    .select("*")
    .single();
  if (error) throw error;
  return toHistoryEntry(data as DocumentRow);
}

/** Links the placeholder to the backend job so a later reload can ask the
 * backend what happened to it. */
export async function attachCheckJobId(id: string, jobId: string): Promise<void> {
  const { error } = await supabase.from("documents").update({ check_job_id: jobId }).eq("id", id);
  if (error) throw error;
}

/** Terminal failure state — the row stops showing a spinner and shows why. */
export async function markCheckFailed(id: string, message: string): Promise<void> {
  const { error } = await supabase
    .from("documents")
    .update({ check_state: "failed", check_error: message })
    .eq("id", id);
  if (error) throw error;
}

/** Router state for re-opening a still-running check on the Analyzing screen.
 * Shared by History and both Documents views so a "Checking" row never lands
 * on an empty report. */
export function analyzingStateFor(entry: HistoryEntryWithCheck) {
  return {
    docLabels: [entry.title],
    project: entry.project,
    jobId: entry.checkJobId,
    documentId: entry.id,
    reportMode: "backend",
  };
}

async function documentExists(id: string): Promise<boolean> {
  const { data, error } = await supabase.from("documents").select("id").eq("id", id).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export interface CheckResults {
  status: DocStatus;
  similarityScore: number;
  wordCount: number;
  webSourcesScanned: number;
  academicSourcesScanned: number;
}

export interface FinalizeCheckParams {
  placeholderId: string;
  /** The backend's report id, which is also the id of the row
   * `report_store.py::_persist_to_supabase` upserts when Supabase is
   * configured for the API process. */
  reportId: string | null;
  /** Omitted when the report body couldn't be fetched — the row is still
   * settled (no stuck spinner), keeping whatever scores the backend wrote. */
  results?: CheckResults;
}

/**
 * Settles a finished check and returns the id the report should be opened by.
 *
 * The backend independently upserts its own `documents` row keyed by report_id,
 * so blindly completing the placeholder would leave the user with two rows for
 * one check. Instead:
 *   - backend row present -> carry the user-authored fields (title/project/
 *     language) onto it and drop the placeholder; the backend row is canonical.
 *   - backend row absent (API running without Supabase configured) -> complete
 *     the placeholder in place so the check isn't lost.
 */
export async function finalizeCheckingDocument(params: FinalizeCheckParams): Promise<string> {
  const { placeholderId, reportId } = params;

  const results = {
    check_state: "completed" as const,
    check_error: null,
    ...(params.results
      ? {
          status: params.results.status,
          similarity_score: params.results.similarityScore,
          similarity_score_free: params.results.similarityScore,
          word_count: params.results.wordCount,
          web_sources_scanned: params.results.webSourcesScanned,
          academic_sources_scanned: params.results.academicSourcesScanned,
        }
      : {}),
  };

  if (reportId && reportId !== placeholderId && (await documentExists(reportId))) {
    const { data: placeholder, error: readError } = await supabase
      .from("documents")
      .select("*")
      .eq("id", placeholderId)
      .maybeSingle();
    if (readError) throw readError;

    if (placeholder) {
      const row = placeholder as DocumentRow;
      const { error: mergeError } = await supabase
        .from("documents")
        .update({
          ...results,
          title: row.title,
          file_name: row.file_name,
          language: row.language,
          project: row.project,
        })
        .eq("id", reportId);
      if (mergeError) throw mergeError;

      const { error: deleteError } = await supabase.from("documents").delete().eq("id", placeholderId);
      if (deleteError) throw deleteError;
    }
    return reportId;
  }

  const { error } = await supabase.from("documents").update(results).eq("id", placeholderId);
  if (error) throw error;
  return placeholderId;
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

// --- Documents (Finder-style) screen helpers -------------------------------
// `documents.project` is a plain nullable text column — there is no
// dedicated projects table, so "projects" are purely a client-side grouping
// by this field. `null` is the conventional "ungrouped" bucket, displayed as
// PROJECTS[0] ("Default") by callers — see store.ts.

/** Bulk-renames every document whose `project` exactly matches `oldProject`
 * to `newProject`, scoped to the given user. Callers should only invoke this
 * for real (non-default) project names — the implicit "Default"/ungrouped
 * bucket (`project IS NULL`) is not renameable through this helper. */
export async function renameProjectDocuments(
  userId: string,
  oldProject: string,
  newProject: string,
): Promise<void> {
  const { error } = await supabase
    .from("documents")
    .update({ project: newProject })
    .eq("user_id", userId)
    .eq("project", oldProject);
  if (error) throw error;
}

/** Moves a single document into `project` (or ungroups it back to the
 * implicit Default bucket when `project` is null). */
export async function moveDocumentToProject(id: string, project: string | null): Promise<void> {
  const { error } = await supabase.from("documents").update({ project }).eq("id", id);
  if (error) throw error;
}

/** "Deletes" a project by ungrouping every matching document back to the
 * implicit Default bucket (`project: null`). Documents themselves are not
 * deleted — only the grouping. Scoped to real (non-default) project names. */
export async function clearProjectFromDocuments(userId: string, project: string): Promise<void> {
  const { error } = await supabase
    .from("documents")
    .update({ project: null })
    .eq("user_id", userId)
    .eq("project", project);
  if (error) throw error;
}

/** Renames a single document's display title. */
export async function renameDocument(id: string, title: string): Promise<void> {
  const { error } = await supabase.from("documents").update({ title }).eq("id", id);
  if (error) throw error;
}

interface DocumentVersionRow {
  id: string;
  document_id: string;
  label: string;
  html: string;
  word_count: number;
  created_at: string;
}

function toDocumentVersion(row: DocumentVersionRow): DocumentVersion {
  return {
    id: row.id,
    label: row.label,
    savedAt: new Date(row.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    wordCount: row.word_count,
    html: row.html,
  };
}

/** Edit-history snapshots for the Report page's Version History menu — see
 * supabase/migrations/20260726000000_document_versions.sql. Distinct from
 * document_passages/document_matches, which hold the *check* result, not
 * user edits made afterward. */
export async function fetchDocumentVersions(documentId: string): Promise<DocumentVersion[]> {
  const { data, error } = await supabase
    .from("document_versions")
    .select("*")
    .eq("document_id", documentId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return (data ?? []).map(toDocumentVersion);
}

export async function saveDocumentVersion(
  documentId: string,
  version: { label: string; html: string; wordCount: number },
): Promise<DocumentVersion> {
  const { data, error } = await supabase
    .from("document_versions")
    .insert({
      document_id: documentId,
      label: version.label,
      html: version.html,
      word_count: version.wordCount,
    })
    .select()
    .single();
  if (error) throw error;
  return toDocumentVersion(data);
}
