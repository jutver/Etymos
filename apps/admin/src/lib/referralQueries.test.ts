// Referral sources screen: how referral survey answers are counted.
import { describe, expect, it } from "vitest";
import { summarizeReferrals, type ReferralResponse } from "./referralQueries";
import type { DateRange } from "./dashboardQueries";

const RANGE: DateRange = { preset: "custom", start: "2026-10-24", end: "2026-10-26" };

let nextId = 1;
const row = (source: ReferralResponse["source"], created_at: string, other_text: string | null = null): ReferralResponse => ({
  id: nextId++,
  source,
  other_text,
  created_at,
  user: null,
});

describe("summarizeReferrals", () => {
  const summary = summarizeReferrals(
    [
      row("tiktok", "2026-10-24T08:00:00Z"),
      row("tiktok", "2026-10-26T09:00:00Z"),
      row("facebook", "2026-10-25T10:00:00Z"),
      row("other", "2026-10-26T11:00:00Z", "Zalo group"),
      row("skipped", "2026-10-26T12:00:00Z"),
    ],
    RANGE,
  );

  it("counts skips toward the times shown but not toward answers", () => {
    expect(summary).toMatchObject({ shown: 5, answered: 4, skipped: 1 });
  });

  it("counts every source in survey order, including ones nobody picked", () => {
    expect(summary.bySource).toEqual([
      { source: "facebook", count: 1 },
      { source: "tiktok", count: 2 },
      { source: "friend", count: 0 },
      { source: "search", count: 0 },
      { source: "other", count: 1 },
    ]);
  });

  it("buckets answers per day across the whole range", () => {
    expect(summary.series.map((d) => [d.date, d.tiktok, d.facebook, d.other])).toEqual([
      ["2026-10-24", 1, 0, 0],
      ["2026-10-25", 0, 1, 0],
      ["2026-10-26", 1, 0, 1],
    ]);
  });

  it("lists answers newest first without the skips", () => {
    expect(summary.answers.map((a) => a.other_text ?? a.source)).toEqual(["Zalo group", "tiktok", "facebook", "tiktok"]);
  });
});
