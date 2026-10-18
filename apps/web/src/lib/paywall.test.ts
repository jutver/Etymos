import { describe, expect, it } from "vitest";
import { effectiveTier, isBalanceReason, parsePaywallReason, paywallPath, upgradePlansFor } from "./paywall";

describe("paywall reasons", () => {
  it("round-trips a reason through the URL and rejects unknown ones", () => {
    expect(paywallPath("export")).toBe("/paywall?reason=export");
    expect(paywallPath("rewrite", "abc")).toBe("/paywall?reason=rewrite&doc=abc");
    expect(paywallPath()).toBe("/paywall");
    expect(parsePaywallReason("export")).toBe("export");
    expect(parsePaywallReason("bogus")).toBeNull();
    expect(parsePaywallReason(null)).toBeNull();
  });

  it("only treats quota and credit shortfalls as balance reasons", () => {
    expect(isBalanceReason("checks")).toBe(true);
    expect(isBalanceReason("premium-credits")).toBe(true);
    expect(isBalanceReason("rewrite")).toBe(false);
    expect(isBalanceReason(null)).toBe(false);
  });

  it("offers only plans above the current one that unlock the feature", () => {
    expect(upgradePlansFor("free", "export")).toEqual(["student", "professional"]);
    expect(upgradePlansFor("free", "rewrite")).toEqual(["professional"]);
    expect(upgradePlansFor("student", "rewrite")).toEqual(["professional"]);
    expect(upgradePlansFor("student", "checks")).toEqual(["professional"]);
    expect(upgradePlansFor("student", "export")).toEqual([]);
    expect(upgradePlansFor("professional", "rewrite")).toEqual([]);
    expect(upgradePlansFor("professional", "checks")).toEqual([]);
  });

  it("lets a document's unlocked tier lift, but never lower, the plan", () => {
    expect(effectiveTier("free", undefined)).toBe("free");
    expect(effectiveTier("free", "student")).toBe("student");
    expect(effectiveTier("student", "professional")).toBe("professional");
    expect(effectiveTier("professional", "student")).toBe("professional");
  });
});
