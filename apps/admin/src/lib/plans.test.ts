import { describe, expect, it } from "vitest";
import { planChecks } from "./plans";

const LIMITS = { free: 2, student: 10, professional: 50 };
const NOW = new Date("2026-11-09T12:00:00Z");
const base = {
  plan_tier: "student" as const,
  plan_expires_at: "2026-12-01T00:00:00Z",
  plan_period_start: "2026-11-01T00:00:00Z",
  checks_used_this_period: 3,
};

describe("planChecks", () => {
  it("counts what's left of the plan's monthly checks", () => {
    const c = planChecks(base, LIMITS, NOW);
    expect(c).toMatchObject({ tier: "student", used: 3, limit: 10, left: 7 });
    expect(c.resetsAt.toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  it("never goes below zero", () => {
    expect(planChecks({ ...base, checks_used_this_period: 14 }, LIMITS, NOW).left).toBe(0);
  });

  it("treats a period that has run its 30 days as unused", () => {
    const c = planChecks({ ...base, plan_period_start: "2026-10-01T00:00:00Z" }, LIMITS, NOW);
    expect(c).toMatchObject({ used: 0, left: 10 });
    expect(c.resetsAt.toISOString()).toBe("2026-11-30T00:00:00.000Z");
  });

  it("counts a lapsed paid plan as Free with nothing used", () => {
    const c = planChecks({ ...base, plan_expires_at: "2026-11-05T00:00:00Z" }, LIMITS, NOW);
    expect(c).toMatchObject({ tier: "free", used: 0, limit: 2, left: 2 });
  });

  it("has no count when the plan has no cap", () => {
    expect(planChecks(base, { ...LIMITS, student: null }, NOW)).toMatchObject({ limit: null, left: null });
  });
});
