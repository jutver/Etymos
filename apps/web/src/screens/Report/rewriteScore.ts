/**
 * Similarity score after the reader rewrites / edits flagged passages.
 *
 * The backend's score (final_report_builder.py) is the weighted share of the
 * document's characters that are matched: Σ span length × LABEL_WEIGHT over
 * the UNION of matched spans, divided by the document length. Fixing a
 * passage therefore lowers the score by that passage's own share — a long
 * copied paragraph counts for much more than a short phrase — instead of the
 * flat 4 points per fix this page used to subtract.
 *
 * The report's stored score stays the anchor: every passage's share is
 * scaled so that all matches together add up to exactly that score, which
 * keeps the estimate consistent with it even when the client cannot rebuild
 * the backend's exact numerator (matches restored from Supabase have no
 * offsets or labels).
 *
 * A rewrite can itself still overlap a source — the same one, or another
 * one from the report. The quick check (backend/quick_check.py) reports
 * those overlaps as `hits`, and each hit adds its sentence's share back —
 * at most the share of the passage it replaced: a rewrite is never counted
 * as worse than the copy it replaced (only a full re-check is exact).
 *
 * A passage whose quick check is still running counts as it was, so the
 * score moves once, when its verdict is in, instead of dropping first and
 * coming back up when the rewrite turns out to still overlap.
 */
import type { MatchedSource } from "../../lib/types";
import type { QuickCheckHit } from "../../lib/api";
import { normalizeWhitespace } from "./replaceMatch";

/** backend/document_model.py's LABEL_WEIGHT. */
export const LABEL_WEIGHT: Record<string, number> = {
  likely_plagiarism: 1,
  suspicious: 0.5,
  common_academic_definition: 0.1,
};

export type PassageCheckStatus = "checking" | "clean" | "flagged" | "unverified";

/** Quick-check state of one changed passage (an accepted rewrite or a hand edit). */
export interface PassageCheck {
  /** Every match the changed passage covered: its highlight and the matches merged into it. */
  matchIds: string[];
  /** The passage text that was (or is being) checked. Empty when it was deleted. */
  text: string;
  status: PassageCheckStatus;
  hits: QuickCheckHit[];
}

export interface ScoreEstimate {
  score: number;
  /** True once anything was changed: only a full re-check gives an exact score. */
  estimated: boolean;
  /** A quick check is still running. */
  checking: boolean;
}

/** Matches without a known label (restored from Supabase) count at full weight. */
function matchWeight(match: MatchedSource): number {
  const label = match.explanationFacts?.label;
  return label !== undefined && label in LABEL_WEIGHT ? LABEL_WEIGHT[label] : 1;
}

/** Matches on the same words (several sources for one sentence) are one span. */
function spanKey(match: MatchedSource): string {
  if (match.startOffset != null && match.endOffset != null) return `@${match.startOffset}-${match.endOffset}`;
  return `#${normalizeWhitespace(match.userSnippet).toLowerCase()}`;
}

function spanLength(match: MatchedSource): number {
  if (match.startOffset != null && match.endOffset != null) return Math.max(0, match.endOffset - match.startOffset);
  return normalizeWhitespace(match.userSnippet).length;
}

interface Interval {
  start: number;
  end: number;
  weight: number;
}

/** Σ over the union of `intervals` of length × the highest weight covering it. */
export function weightedCoverage(intervals: Interval[]): number {
  const bounds = [...new Set(intervals.flatMap((i) => [i.start, i.end]))].sort((a, b) => a - b);
  let sum = 0;
  for (let k = 0; k < bounds.length - 1; k++) {
    const from = bounds[k]!;
    const to = bounds[k + 1]!;
    let weight = 0;
    for (const i of intervals) if (i.start <= from && i.end >= to && i.weight > weight) weight = i.weight;
    sum += (to - from) * weight;
  }
  return sum;
}

function roundScore(score: number): number {
  return Math.round(Math.min(100, Math.max(0, score)) * 10) / 10;
}

export function estimateScore(
  baseScore: number,
  matches: MatchedSource[],
  resolvedIds: ReadonlySet<string>,
  checks: Iterable<PassageCheck>,
): ScoreEstimate {
  const checkList = Array.from(checks);
  const estimated = resolvedIds.size > 0 || checkList.length > 0;
  const checking = checkList.some((c) => c.status === "checking");

  // Passages still being checked keep their old share until the verdict.
  const pending = new Set(checkList.filter((c) => c.status === "checking").flatMap((c) => c.matchIds));

  // Matches on the same words (one sentence, several sources) are one span,
  // fixed as soon as any of them is.
  const spans = new Map<string, { match: MatchedSource; weight: number; fixed: boolean; ids: string[] }>();
  for (const match of matches) {
    const key = spanKey(match);
    const span = spans.get(key);
    const fixed = resolvedIds.has(match.id) && !pending.has(match.id);
    if (span) {
      span.weight = Math.max(span.weight, matchWeight(match));
      span.fixed ||= fixed;
      span.ids.push(match.id);
    } else {
      spans.set(key, { match, weight: matchWeight(match), fixed, ids: [match.id] });
    }
  }

  // Weighted characters of `list`. Spans with offsets: weighted union of
  // character ranges, like the backend's weighted_coverage (partly
  // overlapping spans count once). Spans without offsets: their snippet length.
  const coverage = (list: { match: MatchedSource; weight: number }[]): number => {
    const intervals: Interval[] = [];
    let sum = 0;
    for (const { match, weight } of list) {
      if (match.startOffset != null && match.endOffset != null) {
        intervals.push({ start: match.startOffset, end: match.endOffset, weight });
      } else {
        sum += spanLength(match) * weight;
      }
    }
    return sum + weightedCoverage(intervals);
  };
  const spanList = [...spans.values()];
  const total = coverage(spanList);
  const removed = total - coverage(spanList.filter((span) => !span.fixed));
  if (total <= 0 || baseScore <= 0) return { score: roundScore(baseScore), estimated, checking };

  let addedBack = 0;
  for (const check of checkList) {
    if (check.status !== "flagged") continue;
    const ids = new Set(check.matchIds);
    const replacedShare = coverage(spanList.filter((span) => span.fixed && span.ids.some((id) => ids.has(id))));
    let overlap = 0;
    for (const hit of check.hits) overlap += normalizeWhitespace(hit.input_sentence).length * hit.weight;
    addedBack += Math.min(overlap, replacedShare);
  }

  const pointsPerWeightedChar = baseScore / total;
  return {
    score: roundScore(baseScore - (removed - addedBack) * pointsPerWeightedChar),
    estimated,
    checking,
  };
}
