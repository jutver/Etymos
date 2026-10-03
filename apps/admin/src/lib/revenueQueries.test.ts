// Revenue maths for the admin Revenue page: what counts as revenue, on which
// day, and how the bank-transfer ledger is totalled.
import { describe, expect, it } from "vitest";
import {
  cleanSearch,
  csvRow,
  daysBetween,
  orderDay,
  productKey,
  rangeBoundsVN,
  summarizeRevenue,
  toLocalDay,
} from "./revenueQueries";

type Order = Parameters<typeof summarizeRevenue>[0][number];
type Tx = Parameters<typeof summarizeRevenue>[1][number];

const order = (over: Partial<Order>): Order => ({
  kind: "pack",
  plan_tier: null,
  billing_cycle: null,
  pack_id: "pack-standard",
  amount: 19000,
  paid_amount: 19000,
  paid_at: "2026-10-02T03:00:00Z",
  reviewed_at: null,
  created_at: "2026-10-02T02:55:00Z",
  payment_method: "sepay",
  ...over,
});

const tx = (over: Partial<Tx>): Tx => ({
  amount: 19000,
  transfer_type: "in",
  transaction_date: "2026-10-02T10:00:00+07:00",
  received_at: "2026-10-02T03:00:05Z",
  ...over,
});

const DAYS = daysBetween("2026-10-01", "2026-10-03");

describe("toLocalDay", () => {
  it("uses Vietnam time, so late-evening UTC lands on the next day", () => {
    expect(toLocalDay("2026-10-01T16:59:59Z")).toBe("2026-10-01");
    expect(toLocalDay("2026-10-01T17:00:00Z")).toBe("2026-10-02");
    expect(toLocalDay("2026-10-02T00:30:00+07:00")).toBe("2026-10-02");
  });
});

describe("orderDay", () => {
  it("counts an order on the day it was paid, falling back to approval then creation", () => {
    expect(orderDay({ paid_at: "2026-10-03T01:00:00Z", reviewed_at: null, created_at: "2026-09-30T01:00:00Z" })).toBe("2026-10-03");
    expect(orderDay({ paid_at: null, reviewed_at: "2026-10-02T01:00:00Z", created_at: "2026-09-30T01:00:00Z" })).toBe("2026-10-02");
    expect(orderDay({ paid_at: null, reviewed_at: null, created_at: "2026-09-30T01:00:00Z" })).toBe("2026-09-30");
  });
});

describe("productKey", () => {
  it("separates plans by tier and cycle, packs by id", () => {
    expect(productKey({ kind: "plan", plan_tier: "professional", billing_cycle: "annual", pack_id: null })).toBe(
      "plan:professional:annual",
    );
    expect(productKey({ kind: "pack", plan_tier: null, billing_cycle: null, pack_id: "pack-premium" })).toBe("pack:pack-premium");
  });
});

describe("summarizeRevenue", () => {
  it("totals revenue from what was actually paid and buckets it by day", () => {
    const s = summarizeRevenue(
      [
        order({ paid_amount: 20000 }), // overpaid by 1,000
        order({ kind: "plan", plan_tier: "professional", billing_cycle: "monthly", pack_id: null, amount: 299000, paid_amount: 299000, paid_at: "2026-10-03T02:00:00Z" }),
        // Manual approval from before SePay: no paid_amount/paid_at.
        order({ paid_amount: null, amount: 59000, paid_at: null, reviewed_at: "2026-10-01T05:00:00Z", payment_method: "vnpay" }),
        // Outside the range: ignored.
        order({ paid_at: "2026-09-15T02:00:00Z", paid_amount: 999000 }),
      ],
      [],
      DAYS,
    );
    expect(s.revenue).toBe(20000 + 299000 + 59000);
    expect(s.paidOrders).toBe(3);
    expect(s.averageOrder).toBeCloseTo(378000 / 3);
    expect(s.revenueByDay).toEqual([
      { date: "2026-10-01", value: 59000 },
      { date: "2026-10-02", value: 20000 },
      { date: "2026-10-03", value: 299000 },
    ]);
    expect(s.automatic).toBe(319000);
    expect(s.manual).toBe(59000);
    expect(s.byProduct.map((p) => [p.key, p.amount, p.count])).toEqual([
      ["plan:professional:monthly", 299000, 1],
      ["pack:pack-standard", 79000, 2],
    ]);
  });

  it("counts only incoming transfers as money received, by bank date", () => {
    const s = summarizeRevenue(
      [],
      [
        tx({}),
        tx({ amount: 50000, transaction_date: null, received_at: "2026-10-03T08:00:00Z" }),
        tx({ amount: 1000000, transfer_type: "out" }),
        tx({ amount: 7000, transaction_date: "2026-09-30T23:00:00+07:00" }),
      ],
      DAYS,
    );
    expect(s.received).toBe(69000);
    expect(s.receivedByDay.map((p) => p.value)).toEqual([0, 19000, 50000]);
  });

  it("is all zeros with no data", () => {
    const s = summarizeRevenue([], [], DAYS);
    expect(s).toMatchObject({ revenue: 0, paidOrders: 0, averageOrder: 0, received: 0, byProduct: [] });
    expect(s.revenueByDay).toHaveLength(3);
  });
});

describe("rangeBoundsVN", () => {
  it("spans whole Vietnam days", () => {
    expect(rangeBoundsVN({ preset: "custom", start: "2026-10-01", end: "2026-10-03" })).toEqual({
      gte: "2026-09-30T17:00:00.000Z",
      lte: "2026-10-03T16:59:59.999Z",
    });
  });
});

describe("csvRow", () => {
  it("quotes every field and escapes quotes", () => {
    expect(csvRow(["a", 1, null, 'say "hi", ok'])).toBe('"a","1","","say ""hi"", ok"');
  });
});

describe("cleanSearch", () => {
  it("drops characters that would break a PostgREST or() filter", () => {
    expect(cleanSearch(" ETM7K2,(x)*% ")).toBe("ETM7K2  x");
  });
});
