import { describe, expect, it } from "vitest";
import { actionTone, describeAction, formatValue, type AdminActionEntry } from "./adminActionLogQueries";

function entry(over: Partial<AdminActionEntry>): AdminActionEntry {
  return {
    id: 1,
    created_at: "2026-11-08T03:00:00Z",
    actor_id: "a",
    actor_email: "admin@etymos.site",
    source: "portal",
    action: "profiles.update",
    target_table: "profiles",
    target_id: "u",
    target_user_id: "u",
    summary: "user@example.com",
    changes: {},
    metadata: {},
    ...over,
  };
}

describe("admin action descriptions", () => {
  it("names portal changes by what changed", () => {
    expect(describeAction(entry({}))).toBe("Changed account");
    expect(describeAction(entry({ action: "discount_codes.insert" }))).toBe("Created discount code");
    expect(describeAction(entry({ action: "announcements.delete", changes: { personal: { from: true } } }))).toBe(
      "Deleted personal message",
    );
  });

  it("names backend actions and old audit_log rows", () => {
    expect(describeAction(entry({ source: "backend", action: "support.replied" }))).toBe("Replied to a support ticket");
    expect(describeAction(entry({ action: "audit.plan_changed" }))).toBe("Account action: plan changed");
    expect(describeAction(entry({ action: "something.new" }))).toBe("something.new");
  });

  it("colours creates, changes and deletes", () => {
    expect(actionTone(entry({ action: "credit_packs.insert" }))).toBe("create");
    expect(actionTone(entry({ action: "user.force_deleted" }))).toBe("delete");
    expect(actionTone(entry({ action: "auth.sign_in" }))).toBe("neutral");
  });

  it("formats values", () => {
    expect(formatValue(null)).toBe("empty");
    expect(formatValue(true)).toBe("yes");
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
  });
});
