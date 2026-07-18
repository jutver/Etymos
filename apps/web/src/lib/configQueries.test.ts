// Smoke tests for configQueries.ts: for each exported function, verify the
// empty-state (Supabase returns no rows -> resolves to an empty array) and
// the error-state (Supabase returns an error -> the error surfaces). Both the
// `@etymos/shared` Supabase client and the `./store` side effect
// (setPlanLimitsFromConfig) are mocked; nothing real is hit.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@etymos/shared", () => ({
  supabase: { from: vi.fn() },
}));

vi.mock("./store", () => ({
  setPlanLimitsFromConfig: vi.fn(),
}));

import { supabase } from "@etymos/shared";
import { fetchCreditPacks, fetchPlanDefinitions } from "./configQueries";
import { setPlanLimitsFromConfig } from "./store";

type Result = { data: unknown; error: unknown };

/**
 * Builds a chainable stub mimicking supabase-js's PostgrestFilterBuilder:
 * `.select()/.order()` return the same builder (chainable), and the builder
 * itself is "thenable" so `await supabase.from(...).select(...).order(...)`
 * resolves to `result` without an explicit terminal call.
 */
function makeBuilder(result: Result) {
  const builder: Record<string, unknown> = {
    select: vi.fn(() => builder),
    order: vi.fn(() => builder),
    then: (onFulfilled: (r: Result) => unknown, onRejected: (e: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return builder;
}

/** Configures `supabase.from(table)` to return a per-table builder/result. */
function mockFrom(byTable: Record<string, Result>) {
  (supabase.from as unknown as ReturnType<typeof vi.fn>).mockImplementation((table: string) =>
    makeBuilder(byTable[table] ?? { data: null, error: null }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchPlanDefinitions", () => {
  it("returns an empty array when Supabase returns no rows", async () => {
    mockFrom({ plan_definitions: { data: [], error: null } });
    await expect(fetchPlanDefinitions()).resolves.toEqual([]);
  });

  it("pushes doc/word limits into the store as a side effect on success", async () => {
    mockFrom({
      plan_definitions: {
        data: [
          {
            id: "student",
            name: "Student",
            tagline: null,
            price_monthly: 9,
            price_annual: 90,
            audience: null,
            most_popular: false,
            requires_verification: true,
            features: null,
            doc_limit: 10,
            word_limit: 10000,
            sort_order: 1,
          },
        ],
        error: null,
      },
    });
    const plans = await fetchPlanDefinitions();
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ id: "student", name: "Student" });
    expect(setPlanLimitsFromConfig).toHaveBeenCalledWith([
      { id: "student", docLimit: 10, wordLimit: 10000 },
    ]);
  });

  it("throws when Supabase returns an error, without touching the store", async () => {
    mockFrom({ plan_definitions: { data: null, error: new Error("boom") } });
    await expect(fetchPlanDefinitions()).rejects.toThrow("boom");
    expect(setPlanLimitsFromConfig).not.toHaveBeenCalled();
  });
});

describe("fetchCreditPacks", () => {
  it("returns an empty array when Supabase returns no rows", async () => {
    mockFrom({ credit_packs: { data: [], error: null } });
    await expect(fetchCreditPacks()).resolves.toEqual([]);
  });

  it("throws when Supabase returns an error", async () => {
    mockFrom({ credit_packs: { data: null, error: new Error("boom") } });
    await expect(fetchCreditPacks()).rejects.toThrow("boom");
  });
});
