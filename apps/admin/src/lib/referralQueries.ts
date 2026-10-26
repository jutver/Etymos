// "How did you hear about Etymos?" answers from the web app's first-visit
// survey (supabase/migrations/20261026000000_referral_survey.sql). One row per
// browser, so the table stays small enough to aggregate here, like the main
// Dashboard does.
import { supabase } from "@etymos/shared";
import { daysInRange, rangeBounds, type DateRange } from "./dashboardQueries";
import { tr } from "./i18n";

const FETCH_LIMIT = 10000;

/** Answer sources in the order the web survey lists them; "skipped" is a closed dialog. */
export const REFERRAL_SOURCES = ["facebook", "tiktok", "friend", "search", "other"] as const;
export type ReferralSource = (typeof REFERRAL_SOURCES)[number];

export const REFERRAL_SOURCE_LABELS: Record<ReferralSource, string> = {
  facebook: tr("Facebook"),
  tiktok: tr("TikTok"),
  friend: tr("Friends or classmates"),
  search: tr("Google / search"),
  other: tr("Other"),
};

export interface ReferralResponse {
  id: number;
  source: ReferralSource | "skipped";
  other_text: string | null;
  created_at: string;
  user: { email: string | null } | null;
}

/** A response someone actually answered (not a skip). */
export type ReferralAnswer = ReferralResponse & { source: ReferralSource };

export interface ReferralSummary {
  /** Dialogs shown and closed: answers plus skips. */
  shown: number;
  answered: number;
  skipped: number;
  bySource: { source: ReferralSource; count: number }[];
  /** Per-day answers, one key per source. */
  series: ({ date: string } & Record<ReferralSource, number>)[];
  /** Answers newest first, skips left out. */
  answers: ReferralAnswer[];
}

/** Thrown when the table doesn't exist yet, i.e. the migration hasn't been applied. */
export class ReferralNotSetUpError extends Error {
  constructor() {
    super(
      tr("The referral survey isn't set up on this database yet. Run supabase/migrations/20261026000000_referral_survey.sql in the Supabase SQL Editor."),
    );
    this.name = "ReferralNotSetUpError";
  }
}

export function summarizeReferrals(rows: ReferralResponse[], range: DateRange): ReferralSummary {
  const answers = rows.filter((r): r is ReferralAnswer => r.source !== "skipped");
  const counts = new Map<ReferralSource, number>(REFERRAL_SOURCES.map((s) => [s, 0]));
  const days = new Map(
    daysInRange(range.start, range.end).map((date) => [
      date,
      { date, ...(Object.fromEntries(REFERRAL_SOURCES.map((s) => [s, 0])) as Record<ReferralSource, number>) },
    ]),
  );
  for (const r of answers) {
    counts.set(r.source, (counts.get(r.source) ?? 0) + 1);
    const day = days.get(r.created_at.slice(0, 10));
    if (day) day[r.source] += 1;
  }
  return {
    shown: rows.length,
    answered: answers.length,
    skipped: rows.length - answers.length,
    bySource: REFERRAL_SOURCES.map((source) => ({ source, count: counts.get(source) ?? 0 })),
    series: [...days.values()],
    answers: [...answers].sort((a, b) => b.created_at.localeCompare(a.created_at)),
  };
}

export async function fetchReferralSummary(range: DateRange): Promise<ReferralSummary> {
  const { gte, lte } = rangeBounds(range);
  const { data, error } = await supabase
    .from("referral_survey_responses")
    .select("id, source, other_text, created_at, user:profiles(email)")
    .gte("created_at", gte)
    .lte("created_at", lte)
    .order("created_at", { ascending: false })
    .limit(FETCH_LIMIT);
  if (error) {
    if (error.code === "42P01" || error.code === "PGRST205") throw new ReferralNotSetUpError();
    throw error;
  }
  return summarizeReferrals((data ?? []) as unknown as ReferralResponse[], range);
}
