/**
 * The rows the History tab lists under one file: every check of it (each
 * upload) and every version saved from its report, newest first.
 *
 * A check, and a version that was re-checked, carry a score. A version that
 * was only saved carries none: its text was never checked.
 */
import type { DocumentVersionHistory, HistoryEntryWithCheck, SavedVersionSummary } from "../../lib/documentsQueries";

export type HistoryRow =
  | {
      kind: "check";
      key: string;
      entry: HistoryEntryWithCheck;
      /** Raw timestamp, for ordering and display. */
      at: string;
      /** null while checking / failed, or when the upload's score is unknown. */
      score: number | null;
    }
  | {
      kind: "version";
      key: string;
      entry: HistoryEntryWithCheck;
      at: string;
      version: SavedVersionSummary;
      /** The re-check's score; null when the version was only saved. */
      score: number | null;
    };

export function buildHistoryRows(
  entries: HistoryEntryWithCheck[],
  histories: ReadonlyMap<string, DocumentVersionHistory>,
): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const entry of entries) {
    const history = histories.get(entry.id);
    // After a re-check the document's own score is the newest re-check's;
    // the upload's is the first re-check's previous score.
    const uploadScore =
      entry.checkState !== "completed" ? null : history?.rechecked ? history.uploadScore : entry.similarityScore;
    rows.push({ kind: "check", key: `check-${entry.id}`, entry, at: entry.startedAt, score: uploadScore });
    for (const version of history?.versions ?? []) {
      rows.push({ kind: "version", key: `version-${version.id}`, entry, at: version.createdAt, version, score: version.score });
    }
  }
  return rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
