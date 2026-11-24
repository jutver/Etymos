import { afterEach, describe, expect, it } from "vitest";
import type { AdminActionEntry } from "./adminActionLogQueries";
import {
  DEBUG_MODE_STORAGE_KEY,
  buildSimpleActionFeed,
  formatHumanFieldLabel,
  formatHumanValue,
  readDebugMode,
  writeDebugMode,
} from "./adminActionLogView";
import { setLanguage } from "./i18n";

function entry(over: Partial<AdminActionEntry>): AdminActionEntry {
  return {
    id: 1,
    created_at: "2026-11-24T16:11:08.000Z",
    actor_id: "admin-1",
    actor_email: "duong2mailegend@gmail.com",
    source: "portal",
    action: "announcements.update",
    target_table: "announcements",
    target_id: "6a00e865-315f-4e3b-8238-4e231196fe96",
    target_user_id: null,
    summary: "Temporary Service Disruption",
    changes: {},
    metadata: {},
    ...over,
  };
}

afterEach(() => {
  setLanguage("en");
  delete (globalThis as { window?: unknown }).window;
});

describe("adminActionLogView", () => {
  it("formats field labels, strips boilerplate keys, and localizes values in Simple mode", () => {
    setLanguage("en");
    expect(formatHumanFieldLabel("starts_at")).toBe("Start time");
    expect(formatHumanFieldLabel("custom_field_name")).toBe("Custom field name");
    expect(formatHumanValue("starts_at", null)).toBe("Immediately");
    expect(formatHumanValue("ends_at", null)).toBe("No end date");
    expect(formatHumanValue("countdown_to", null)).toBe("Off");
    expect(formatHumanValue("is_active", true)).toBe("Yes");
    expect(formatHumanValue("kind", "popup")).toBe("Pop-up");
    expect(formatHumanValue("plan_tier", "student")).toBe("Standard");
    expect(formatHumanValue("starts_at", "2026-11-21T09:45:00+00:00")).not.toContain("T09:45:00+00:00");

    const feed = buildSimpleActionFeed([
      entry({
        summary: null,
        changes: {
          id: { to: "6a00e865-315f-4e3b-8238-4e231196fe96" },
          updated_at: { from: "2026-11-21T00:00:00Z", to: "2026-11-24T00:00:00Z" },
          title: { to: "Fallback Title From Changes" },
          starts_at: { from: "2026-11-21T09:45:00+00:00", to: null },
        },
      }),
    ]);

    expect(feed).toHaveLength(1);
    const item = feed[0]!;
    expect(item.subjectText).toBe("Fallback Title From Changes");
    expect(item.fieldChanges.map((c) => c.label)).toEqual(["Title", "Start time"]);
    expect(item.fieldChanges[1]?.to).toBe("Immediately");

    setLanguage("vi");
    expect(formatHumanFieldLabel("starts_at")).toBe("Thời gian bắt đầu");
    expect(formatHumanValue("starts_at", null)).toBe("Ngay lập tức");
  });

  it("collapses the screenshot-style historical burst into a single clean item", () => {
    const annId = "6a00e865-315f-4e3b-8238-4e231196fe96";
    const ts = "2026-11-24T16:11:08.804Z";
    const rows: AdminActionEntry[] = [
      entry({
        id: 105,
        created_at: ts,
        action: "announcement_emails.insert",
        target_table: "announcement_emails",
        target_id: `${annId}/nnq210805@gmail.com`,
        summary: "nnq210805@gmail.com",
        changes: { email: { to: "nnq210805@gmail.com" }, announcement_id: { to: annId } },
      }),
      entry({
        id: 104,
        created_at: ts,
        action: "announcement_emails.insert",
        target_table: "announcement_emails",
        target_id: `${annId}/otsuk4fu@gmail.com`,
        summary: "otsuk4fu@gmail.com",
        changes: { email: { to: "otsuk4fu@gmail.com" }, announcement_id: { to: annId } },
      }),
      entry({
        id: 103,
        created_at: "2026-11-24T16:11:08.500Z",
        action: "announcement_emails.delete",
        target_table: "announcement_emails",
        target_id: `${annId}/nnq210805@gmail.com`,
        summary: "nnq210805@gmail.com",
        changes: { email: { from: "nnq210805@gmail.com" }, announcement_id: { from: annId } },
      }),
      entry({
        id: 102,
        created_at: "2026-11-24T16:11:08.400Z",
        action: "announcement_emails.delete",
        target_table: "announcement_emails",
        target_id: `${annId}/otsuk4fu@gmail.com`,
        summary: "otsuk4fu@gmail.com",
        changes: { email: { from: "otsuk4fu@gmail.com" }, announcement_id: { from: annId } },
      }),
      entry({
        id: 101,
        created_at: "2026-11-24T16:11:08.100Z",
        action: "announcements.update",
        target_table: "announcements",
        target_id: annId,
        summary: "We'll be back soon",
        changes: { starts_at: { from: "2026-11-21T09:45:00+00:00", to: null } },
      }),
    ];

    const feed = buildSimpleActionFeed(rows);
    expect(feed).toHaveLength(1);
    expect(feed[0]!.entries).toHaveLength(5);
    expect(feed[0]!.subjectText).toBe("We'll be back soon");
    expect(feed[0]!.fieldChanges).toHaveLength(1);
    expect(feed[0]!.fieldChanges[0]).toMatchObject({ label: "Start time", to: "Immediately" });
    expect(feed[0]!.inlineSummary).toContain("Start time:");
    expect(feed[0]!.inlineSummary).toContain("Immediately");
  });

  it("suppresses pure no-op bursts and legacy maintenance_bypass churn, and keeps real net deltas", () => {
    const annId = "11111111-1111-1111-1111-111111111111";
    const pureNoop = buildSimpleActionFeed([
      entry({
        id: 2,
        action: "maintenance_bypass.insert",
        target_table: "maintenance_bypass",
        target_id: `${annId}/a@b.com`,
        summary: "a@b.com",
        changes: { email: { to: "a@b.com" } },
      }),
      entry({
        id: 1,
        action: "maintenance_bypass.delete",
        target_table: "maintenance_bypass",
        target_id: `${annId}/a@b.com`,
        summary: "a@b.com",
        changes: { email: { from: "a@b.com" } },
      }),
    ]);
    expect(pureNoop).toEqual([]);

    const partial = buildSimpleActionFeed([
      entry({
        id: 13,
        action: "announcement_emails.insert",
        target_table: "announcement_emails",
        target_id: `${annId}/keep@etymos.site`,
        summary: "keep@etymos.site",
        changes: { email: { to: "keep@etymos.site" } },
      }),
      entry({
        id: 12,
        action: "announcement_emails.insert",
        target_table: "announcement_emails",
        target_id: `${annId}/new@etymos.site`,
        summary: "new@etymos.site",
        changes: { email: { to: "new@etymos.site" } },
      }),
      entry({
        id: 11,
        action: "announcement_emails.delete",
        target_table: "announcement_emails",
        target_id: `${annId}/keep@etymos.site`,
        summary: "keep@etymos.site",
        changes: { email: { from: "keep@etymos.site" } },
      }),
      entry({
        id: 10,
        action: "announcement_emails.delete",
        target_table: "announcement_emails",
        target_id: `${annId}/old@etymos.site`,
        summary: "old@etymos.site",
        changes: { email: { from: "old@etymos.site" } },
      }),
    ]);

    expect(partial).toHaveLength(1);
    expect(partial[0]!.actionText).toBe("Updated announcement recipients");
    expect(partial[0]!.fieldChanges).toEqual([
      { key: "_recipients_added", label: "Recipients added", to: "new@etymos.site", kind: "added" },
      { key: "_recipients_removed", label: "Recipients removed", from: "old@etymos.site", kind: "removed" },
    ]);
  });

  it("never merges entries across different admins, different announcements, >5000ms gaps, or announcement_views", () => {
    const annA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const annB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    const separate = buildSimpleActionFeed([
      entry({
        id: 4,
        actor_id: "admin-1",
        target_table: "announcement_views",
        target_id: `${annA}/user-1`,
        action: "announcement_views.insert",
        changes: {},
      }),
      entry({
        id: 3,
        actor_id: "admin-2",
        actor_email: "other@etymos.site",
        action: "announcement_emails.insert",
        target_table: "announcement_emails",
        target_id: `${annA}/x@y.com`,
        summary: "x@y.com",
      }),
      entry({
        id: 2,
        actor_id: "admin-1",
        created_at: "2026-11-24T16:11:20.000Z",
        target_id: annA,
        changes: { is_active: { from: false, to: true } },
      }),
      entry({
        id: 1,
        actor_id: "admin-1",
        created_at: "2026-11-24T16:11:00.000Z",
        target_id: annB,
        changes: { is_active: { from: true, to: false } },
      }),
    ]);

    expect(separate).toHaveLength(4);
  });

  it("reads and writes DebugModePreference safely across localStorage states", () => {
    const store = new Map<string, string>();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    };
    expect(readDebugMode()).toBe(false);
    writeDebugMode(true);
    expect(store.get(DEBUG_MODE_STORAGE_KEY)).toBe("1");
    expect(readDebugMode()).toBe(true);
    writeDebugMode(false);
    expect(readDebugMode()).toBe(false);

    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
      },
    };
    expect(readDebugMode()).toBe(false);
    expect(() => writeDebugMode(true)).not.toThrow();
  });

  it("summarizes large recipient additions (10+), propagates targetUserId, and degrades unknown actions", () => {
    const annId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const bulkRows = Array.from({ length: 11 }, (_, idx) =>
      entry({
        id: 200 + idx,
        action: "announcement_emails.insert",
        target_table: "announcement_emails",
        target_id: `${annId}/u${idx}@etymos.site`,
        target_user_id: idx === 0 ? "user-deep-link" : null,
        summary: `u${idx}@etymos.site`,
        changes: { email: { to: `u${idx}@etymos.site` } },
      }),
    );
    const futureRow = entry({
      id: 199,
      action: "future_area.custom_event",
      target_table: null,
      target_id: null,
      summary: null,
      changes: {},
    });

    const feed = buildSimpleActionFeed([...bulkRows, futureRow]);
    expect(feed).toHaveLength(2);
    expect(feed[0]!.inlineSummary).toBe("Added 11 recipients");
    expect(feed[0]!.targetUserId).toBe("user-deep-link");
    expect(feed[0]!.fieldChanges[0]!.to).toContain("(+6)");
    expect(feed[1]!.actionText).toBe("future_area.custom_event");
    expect(feed[1]!.canExpand).toBe(false);
  });
});
