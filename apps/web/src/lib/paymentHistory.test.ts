import { describe, expect, it } from "vitest";
import { orderState, totalPaid } from "./paymentHistory";

describe("orderState", () => {
  const now = new Date("2026-10-04T00:00:00Z").getTime();
  it("maps order rows to what the customer sees", () => {
    expect(orderState({ status: "success", expires_at: null }, now)).toBe("paid");
    expect(orderState({ status: "cancelled", expires_at: null }, now)).toBe("cancelled");
    expect(orderState({ status: "declined", expires_at: null }, now)).toBe("declined");
    expect(orderState({ status: "pending", expires_at: "2026-10-04T00:10:00Z" }, now)).toBe("awaiting");
    expect(orderState({ status: "pending", expires_at: "2026-10-03T23:00:00Z" }, now)).toBe("expired");
    expect(orderState({ status: "pending", expires_at: null }, now)).toBe("awaiting");
  });
});

describe("totalPaid", () => {
  it("sums what was actually paid on paid orders only", () => {
    expect(
      totalPaid([
        { status: "success", paid_amount: 19000, amount: 19000 },
        { status: "success", paid_amount: null, amount: 59000 },
        { status: "success", paid_amount: 20000, amount: 19000 },
        { status: "pending", paid_amount: null, amount: 299000 },
        { status: "cancelled", paid_amount: null, amount: 299000 },
      ]),
    ).toBe(98000);
  });
});
