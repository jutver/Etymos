// The originality timeline: one document's checks (the upload, then each
// Save & re-check) in time order, with the drafts saved in between. Feeds the
// Progress strip in Version History and the full timeline dialog.
import { t, currentLocale } from "../../lib/i18n";
import type { DocumentVersion } from "./VersionHistoryMenu";
import { versionChanges } from "./versionStats";

export type TimelineKind = "upload" | "free_recheck" | "paid_recheck" | "draft";

export interface TimelinePoint {
  id: string;
  kind: TimelineKind;
  /** ISO time it was saved or checked; null when unknown. */
  at: string | null;
  label: string;
  /** Similarity and AI-writing scores (0..100); null for a draft, and AI null
   * when detection didn't run. */
  similarity: number | null;
  ai: number | null;
  wordCount: number | null;
  /** Share of the text changed since the version before it (0..1). */
  changedRatio: number | null;
  /** The version to restore; null for an upload known only from the first
   * re-check's "before" score. */
  version: DocumentVersion | null;
}

export interface TimelineSummary {
  checks: number;
  drafts: number;
  first: number;
  latest: number;
  /** latest − first, in whole points (negative = more original). */
  delta: number;
  best: TimelinePoint;
  /** First and latest AI scores among checks where it ran; null with fewer than two. */
  aiFirst: number | null;
  aiLatest: number | null;
  aiDelta: number | null;
}

export interface Timeline {
  /** Oldest first. */
  points: TimelinePoint[];
  /** Null until there are two checks to compare. */
  summary: TimelineSummary | null;
}

/**
 * Builds the timeline from Version History's lists.
 * `versions` is newest first, as the menu holds it; `original` is the stored
 * upload result (fetchUploadVersion). Without it, the upload's score comes
 * from the oldest re-check's "before" score, when there is one.
 */
export function buildTimeline({
  versions,
  original = null,
  uploadedAt = null,
}: {
  versions: DocumentVersion[];
  original?: DocumentVersion | null;
  /** The document's upload date, which beats the stored row's time (that row
   * is written at the first re-check). */
  uploadedAt?: string | null;
}): Timeline {
  const changes = versionChanges(versions);
  const oldestFirst = [...versions].reverse();
  const points: TimelinePoint[] = [];

  const firstCheck = oldestFirst.find((v) => v.check)?.check;
  if (original?.check) {
    points.push({
      id: original.id,
      kind: "upload",
      at: uploadedAt ?? original.createdAt ?? null,
      label: original.label,
      similarity: Math.round(original.check.score),
      ai: roundOrNull(original.check.aiScore),
      wordCount: original.wordCount,
      changedRatio: null,
      version: original,
    });
  } else if (firstCheck && firstCheck.previousScore !== null) {
    points.push({
      id: "upload",
      kind: "upload",
      at: uploadedAt,
      label: "Original upload",
      similarity: Math.round(firstCheck.previousScore),
      ai: roundOrNull(firstCheck.previousAiScore),
      wordCount: null,
      changedRatio: null,
      version: null,
    });
  }

  for (const v of oldestFirst) {
    points.push({
      id: v.id,
      kind: v.check ? (v.check.paid ? "paid_recheck" : "free_recheck") : "draft",
      at: v.createdAt ?? null,
      label: v.label,
      similarity: v.check ? Math.round(v.check.score) : null,
      ai: v.check ? roundOrNull(v.check.aiScore) : null,
      wordCount: v.wordCount,
      changedRatio: changes.get(v.id) ?? null,
      version: v,
    });
  }

  return { points, summary: summarize(points) };
}

function roundOrNull(value: number | null | undefined): number | null {
  return value == null ? null : Math.round(value);
}

function summarize(points: TimelinePoint[]): TimelineSummary | null {
  const checks = points.filter((p) => p.similarity !== null);
  if (checks.length < 2) return null;
  const first = checks[0].similarity!;
  const latest = checks[checks.length - 1].similarity!;
  // The earliest lowest score, so "best" names when it was first reached.
  const best = checks.reduce((a, b) => (b.similarity! < a.similarity! ? b : a));
  const withAi = checks.filter((p) => p.ai !== null);
  const aiFirst = withAi.length >= 2 ? withAi[0].ai : null;
  const aiLatest = withAi.length >= 2 ? withAi[withAi.length - 1].ai : null;
  return {
    checks: checks.length,
    drafts: points.length - checks.length,
    first,
    latest,
    delta: latest - first,
    best,
    aiFirst,
    aiLatest,
    aiDelta: aiFirst !== null && aiLatest !== null ? aiLatest - aiFirst : null,
  };
}

/** True when a timeline point is a check (it has scores). */
export function isCheckPoint(point: TimelinePoint): boolean {
  return point.similarity !== null;
}

export function formatPointDate(at: string | null): string {
  if (!at) return "";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  // A bare YYYY-MM-DD (the upload date) has no time worth showing.
  return /^\d{4}-\d{2}-\d{2}$/.test(at)
    ? date.toLocaleDateString(currentLocale(), { day: "numeric", month: "short" })
    : date.toLocaleString(currentLocale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Screen-reader text for one point, e.g. "Version 2, 3 Nov, 14:05: Similarity 14%, AI 12%". */
export function pointLabel(p: TimelinePoint, showAi: boolean): string {
  const when = formatPointDate(p.at);
  const head = when ? `${t(p.label)}, ${when}` : t(p.label);
  if (!isCheckPoint(p)) return `${head}: ${t("Draft")}`;
  const scores = [t("Similarity {{score}}%", { score: p.similarity! })];
  if (showAi && p.ai !== null) scores.push(t("AI {{score}}%", { score: p.ai }));
  return `${head}: ${scores.join(", ")}`;
}
