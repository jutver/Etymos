// MRR on the admin dashboard: only plans someone paid for, while the paid
// term is still running. Plans an admin granted by hand don't count.
import { describe, expect, it } from "vitest";
import { paidMrr, type PaidPlanOrder } from "./dashboardQueries";

const NOW = new Date("2026-10-20T00:00:00Z");

const order = (over: Partial<PaidPlanOrder>): PaidPlanOrder => ({
  user_id: "u1",
  plan_tier: "student",
  billing_cycle: "monthly",
  amount: 59000,
  paid_amount: 59000,
  paid_at: "2026-10-10T00:00:00Z",
  reviewed_at: null,
  created_at: "2026-10-10T00:00:00Z",
  ...over,
});

describe("paidMrr", () => {
  it("counts a paid plan whose term is still running", () => {
    expect(paidMrr([{ id: "u1", plan_tier: "student" }], [order({})], NOW)).toBe(59000);
  });

  it("ignores a plan an admin granted without an order", () => {
    expect(paidMrr([{ id: "u1", plan_tier: "professional" }], [], NOW)).toBe(0);
  });

  it("ignores an admin grant of a different plan than the one paid for", () => {
    expect(paidMrr([{ id: "u1", plan_tier: "professional" }], [order({})], NOW)).toBe(0);
  });

  it("ignores a grant made after the paid term ran out", () => {
    const old = order({ paid_at: "2026-08-01T00:00:00Z" });
    expect(paidMrr([{ id: "u1", plan_tier: "student" }], [old], NOW)).toBe(0);
  });

  it("spreads an annual payment over twelve months", () => {
    const annual = order({ billing_cycle: "annual", amount: 600000, paid_amount: 600000, paid_at: "2026-03-01T00:00:00Z" });
    expect(paidMrr([{ id: "u1", plan_tier: "student" }], [annual], NOW)).toBe(50000);
  });

  it("stacks early renewals of the same plan", () => {
    const first = order({ paid_at: "2026-08-25T00:00:00Z" });
    const renewal = order({ paid_at: "2026-09-01T00:00:00Z" });
    expect(paidMrr([{ id: "u1", plan_tier: "student" }], [renewal, first], NOW)).toBe(59000);
  });

  it("uses what was actually paid, after discounts", () => {
    const discounted = order({ amount: 59000, paid_amount: 29500 });
    expect(paidMrr([{ id: "u1", plan_tier: "student" }], [discounted], NOW)).toBe(29500);
  });

  it("skips free profiles", () => {
    expect(paidMrr([{ id: "u1", plan_tier: "free" }], [order({})], NOW)).toBe(0);
  });
});
