// Tests for analytics.ts: route normalization, the exact row written, and the
// guarantee that tracking never throws or keeps retrying a missing table. The
// `@etymos/shared` Supabase client is mocked; nothing real is hit.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const insert = vi.fn();
const getSession = vi.fn();

vi.mock("@etymos/shared", () => ({
  supabase: {
    auth: { getSession: (...args: unknown[]) => getSession(...args) },
    from: vi.fn(() => ({ insert: (...args: unknown[]) => insert(...args) })),
  },
}));

function stubBrowser() {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    location: { pathname: "/upload" },
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  });
}

/** Fresh module instance per test — `disabled`/failure counters are module state. */
async function load() {
  vi.resetModules();
  return import("./analytics");
}

/** trackEvent is fire-and-forget; let its promise chain settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  insert.mockReset().mockResolvedValue({ error: null });
  getSession.mockReset().mockResolvedValue({ data: { session: { user: { id: "user-1" } } } });
  stubBrowser();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizePath", () => {
  it("collapses id-like segments so every report shares one row", async () => {
    const { normalizePath } = await load();
    expect(normalizePath("/report/3f2a9c1e-7b5d-4e60-9a1b-0c8d2e4f6a71")).toBe("/report/:id");
    expect(normalizePath("/report/abc123def456ghi")).toBe("/report/:id");
  });

  it("leaves ordinary routes untouched", async () => {
    const { normalizePath } = await load();
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("/pricing")).toBe("/pricing");
    expect(normalizePath("/account/plan")).toBe("/account/plan");
  });
});

describe("trackEvent", () => {
  it("writes user id, a stable session id, event name, route pattern and properties", async () => {
    const { trackEvent } = await load();
    trackEvent("check_started", { input: "paste" });
    trackEvent("report_viewed", {}, "/report/:id");
    await flush();

    expect(insert).toHaveBeenCalledTimes(2);
    const [first, second] = insert.mock.calls.map((c) => c[0]);
    expect(first).toMatchObject({
      user_id: "user-1",
      event_name: "check_started",
      path: "/upload",
      properties: { input: "paste" },
    });
    expect(second).toMatchObject({ event_name: "report_viewed", path: "/report/:id" });
    // Same tab session -> same session id (funnel/session-length depend on it).
    expect(first.session_id).toBe(second.session_id);
    expect(first.session_id.length).toBeGreaterThanOrEqual(8);
  });

  it("records signed-out visitors with a null user id", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    const { trackPageView } = await load();
    trackPageView("/pricing");
    await flush();
    expect(insert.mock.calls[0]?.[0]).toMatchObject({ user_id: null, event_name: "page_view", path: "/pricing" });
  });

  it("never throws when the network call rejects", async () => {
    insert.mockRejectedValue(new Error("Failed to fetch"));
    const { trackEvent } = await load();
    expect(() => trackEvent("check_started")).not.toThrow();
    await flush();
  });

  it("stops sending once the events table is missing (migration not applied)", async () => {
    insert.mockResolvedValue({ error: { code: "PGRST205", message: "no table" } });
    const { trackEvent } = await load();
    trackEvent("page_view");
    await flush();
    trackEvent("page_view");
    trackEvent("page_view");
    await flush();
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
