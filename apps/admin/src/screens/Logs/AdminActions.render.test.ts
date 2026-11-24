import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminActionEntry } from "../../lib/adminActionLogQueries";
import { setLanguage } from "../../lib/i18n";
import AdminActionsPage, { AdminActionFeed } from "./AdminActions";

const ANN_ID = "6a00e865-315f-4e3b-8238-4e231196fe96";

const SAMPLE_BURST: AdminActionEntry[] = [
  {
    id: 3,
    created_at: "2026-11-24T16:11:08.804Z",
    actor_id: "a1",
    actor_email: "duong2mailegend@gmail.com",
    source: "portal",
    action: "announcement_emails.insert",
    target_table: "announcement_emails",
    target_id: `${ANN_ID}/nnq210805@gmail.com`,
    target_user_id: null,
    summary: "nnq210805@gmail.com",
    changes: { email: { to: "nnq210805@gmail.com" }, announcement_id: { to: ANN_ID } },
    metadata: {},
  },
  {
    id: 2,
    created_at: "2026-11-24T16:11:08.500Z",
    actor_id: "a1",
    actor_email: "duong2mailegend@gmail.com",
    source: "portal",
    action: "announcement_emails.delete",
    target_table: "announcement_emails",
    target_id: `${ANN_ID}/nnq210805@gmail.com`,
    target_user_id: null,
    summary: "nnq210805@gmail.com",
    changes: { email: { from: "nnq210805@gmail.com" }, announcement_id: { from: ANN_ID } },
    metadata: {},
  },
  {
    id: 1,
    created_at: "2026-11-24T16:11:08.100Z",
    actor_id: "a1",
    actor_email: "duong2mailegend@gmail.com",
    source: "portal",
    action: "announcements.update",
    target_table: "announcements",
    target_id: ANN_ID,
    target_user_id: null,
    summary: "We'll be back soon",
    changes: { starts_at: { from: "2026-11-21T09:45:00+00:00", to: null } },
    metadata: { request_id: "req-abc123" },
  },
];

afterEach(() => setLanguage("en"));

describe("AdminActions SSR rendering", () => {
  it("renders Simple mode cleanly without raw keys, IDs, or database footers", () => {
    const html = renderToString(
      createElement(
        MemoryRouter,
        null,
        createElement(AdminActionFeed, {
          rows: SAMPLE_BURST,
          debugMode: false,
          openKeys: new Set(["simple-1"]),
          onToggle: vi.fn(),
          hasFilters: false,
          onEnableDebugMode: vi.fn(),
        }),
      ),
    );

    expect(html).toContain("We&#x27;ll be back soon");
    expect(html).toContain("Start time");
    expect(html).toContain("Immediately");
    expect(html).not.toContain("starts_at");
    expect(html).not.toContain(ANN_ID);
    expect(html).not.toContain("recorded by the database");
    expect(html).not.toContain("deleted announcement recipient");
  });

  it("renders Debug mode with raw keys, ungrouped rows, request links, and footers", () => {
    const html = renderToString(
      createElement(
        MemoryRouter,
        null,
        createElement(AdminActionFeed, {
          rows: SAMPLE_BURST,
          debugMode: true,
          openKeys: new Set(["raw-1"]),
          onToggle: vi.fn(),
          hasFilters: false,
          onEnableDebugMode: vi.fn(),
        }),
      ),
    );

    expect(html).toContain("deleted announcement recipient");
    expect(html).toContain("created announcement recipient");
    expect(html).toContain("starts_at");
    expect(html).toContain(ANN_ID);
    expect(html).toContain("req-abc123");
    expect(html).toContain("recorded by the database");
  });

  it("renders an inline note when all loaded Simple mode entries collapse as no-ops", () => {
    const html = renderToString(
      createElement(
        MemoryRouter,
        null,
        createElement(AdminActionFeed, {
          rows: SAMPLE_BURST.slice(0, 2),
          debugMode: false,
          openKeys: new Set<string>(),
          onToggle: vi.fn(),
          hasFilters: false,
          onEnableDebugMode: vi.fn(),
        }),
      ),
    );

    expect(html).toContain("All entries in this batch were hidden as unchanged updates.");
    expect(html).toContain("Show in Debug mode");
  });

  it("renders the Debug mode toolbar toggle in English and Vietnamese", () => {
    const enHtml = renderToString(createElement(MemoryRouter, null, createElement(AdminActionsPage)));
    expect(enHtml).toContain("Debug mode");
    expect(enHtml).toContain('aria-pressed="false"');

    setLanguage("vi");
    const viHtml = renderToString(createElement(MemoryRouter, null, createElement(AdminActionsPage)));
    expect(viHtml).toContain("Chế độ gỡ lỗi");
  });
});
