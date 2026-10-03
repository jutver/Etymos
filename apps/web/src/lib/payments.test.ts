// Checkout helpers: what we send the payments API, which unpaid order we
// resume, and how API errors and countdowns read to the user.
import { afterEach, describe, expect, it } from "vitest";
import { ApiError, type PaymentOrder } from "./api";
import { setLanguage } from "./i18n";
import { describeOrder, isDiscountError, orderMatches, paymentErrorMessage, timeLeft, toPaymentItem } from "./payments";

const order = (over: Partial<PaymentOrder> = {}): PaymentOrder => ({
  id: "o1",
  status: "pending",
  kind: "pack",
  plan_tier: null,
  billing_cycle: null,
  pack_id: "pack-standard",
  quantity: 3,
  amount: 57000,
  list_amount: 57000,
  payment_code: "ETM7K2QF9XA",
  created_at: "2026-10-04T03:00:00Z",
  expires_at: "2026-10-04T03:30:00Z",
  paid_at: null,
  transfer: null,
  ...over,
});

afterEach(() => setLanguage("en"));

describe("toPaymentItem", () => {
  it("sends quantity only for packs", () => {
    expect(toPaymentItem({ kind: "pack", packId: "pack-premium" }, 4)).toEqual({
      kind: "pack",
      pack_id: "pack-premium",
      quantity: 4,
    });
    expect(toPaymentItem({ kind: "plan", plan: "professional", billingCycle: "annual" }, 4)).toEqual({
      kind: "plan",
      plan_tier: "professional",
      billing_cycle: "annual",
    });
  });
});

describe("orderMatches", () => {
  it("resumes an order for the same pack, whatever the quantity", () => {
    expect(orderMatches(order({ quantity: 7 }), { kind: "pack", packId: "pack-standard" })).toBe(true);
    expect(orderMatches(order(), { kind: "pack", packId: "pack-premium" })).toBe(false);
  });

  it("needs the same plan and billing cycle", () => {
    const plan = order({ kind: "plan", plan_tier: "professional", billing_cycle: "monthly", pack_id: null, quantity: 1 });
    expect(orderMatches(plan, { kind: "plan", plan: "professional", billingCycle: "monthly" })).toBe(true);
    expect(orderMatches(plan, { kind: "plan", plan: "professional", billingCycle: "annual" })).toBe(false);
    expect(orderMatches(plan, { kind: "plan", plan: "student", billingCycle: "monthly" })).toBe(false);
    expect(orderMatches(plan, { kind: "pack", packId: "pack-standard" })).toBe(false);
  });
});

describe("paymentErrorMessage", () => {
  it("explains discount code problems", () => {
    expect(paymentErrorMessage(new ApiError("discount_expired", 400))).toBe("This discount code has expired.");
    expect(paymentErrorMessage(new ApiError("discount_already_used", 400))).toBe("You have already used this discount code.");
    expect(isDiscountError(new ApiError("discount_invalid", 400))).toBe(true);
    expect(isDiscountError(new ApiError("verification_required", 403))).toBe(false);
  });

  it("covers configuration, rate limits and unknown errors", () => {
    expect(paymentErrorMessage(new ApiError("payments_not_configured", 503))).toMatch(/aren't available/);
    expect(paymentErrorMessage(new ApiError("Rate limit exceeded: 30 per 1 hour", 429))).toMatch(/Too many requests/);
    expect(paymentErrorMessage(new Error("boom"))).toBe("boom");
    expect(paymentErrorMessage("??")).toBe("Something went wrong.");
  });

  it("is translated", () => {
    setLanguage("vi");
    expect(paymentErrorMessage(new ApiError("discount_expired", 400))).toBe("Mã giảm giá này đã hết hạn.");
  });
});

describe("describeOrder", () => {
  it("names plans and packs", () => {
    expect(describeOrder(order())).toBe("Standard credit pack ×3");
    expect(describeOrder(order({ quantity: 1, pack_id: "pack-premium" }))).toBe("Premium credit pack");
    expect(
      describeOrder(order({ kind: "plan", plan_tier: "professional", billing_cycle: "annual", pack_id: null, quantity: 1 })),
    ).toBe("Premium plan (annual)");
  });
});

describe("timeLeft", () => {
  const expires = "2026-10-04T03:30:00Z";
  const at = (iso: string) => new Date(iso).getTime();

  it("counts down in m:ss", () => {
    expect(timeLeft(expires, at("2026-10-04T03:00:00Z"))).toBe("30:00");
    expect(timeLeft(expires, at("2026-10-04T03:29:05.500Z"))).toBe("0:55");
  });

  it("is null once expired or without an expiry", () => {
    expect(timeLeft(expires, at("2026-10-04T03:30:00Z"))).toBeNull();
    expect(timeLeft(expires, at("2026-10-04T04:00:00Z"))).toBeNull();
    expect(timeLeft(null, Date.now())).toBeNull();
  });
});
