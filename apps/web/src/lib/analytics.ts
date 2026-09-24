// First-party product analytics: fire-and-forget events written to
// `public.user_events` (see supabase/migrations/20260727000000_*), read back by
// the admin portal's Activity screen.
//
// Design rules:
//  - Tracking must NEVER break or slow the app: every path swallows its own
//    errors and callers never await it.
//  - No PII and no document content — only an event name, a route *pattern*
//    (`/report/:id`, never a raw id) and a few small, non-sensitive properties.
//  - Works signed-out too (user_id stays null), which is what lets the funnel
//    count landing-page visitors before they sign up.
import { supabase } from "@etymos/shared";

const SESSION_STORAGE_KEY = "etymos.analytics.session";
/** Give up for the rest of the tab session after this many consecutive network failures. */
const MAX_CONSECUTIVE_FAILURES = 5;

let fallbackSessionId: string | null = null;
let disabled = false;
let consecutiveFailures = 0;

function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/** Random per browser tab session — no cookie, so no consent banner is needed for it. */
function getSessionId(): string {
  try {
    const existing = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) return existing;
    const id = newId();
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, id);
    return id;
  } catch {
    // sessionStorage blocked (private mode, sandboxed iframe): fall back to memory.
    fallbackSessionId ??= newId();
    return fallbackSessionId;
  }
}

/**
 * Replaces id-like segments so every report shares one row in "top pages":
 * `/report/3f2a…` -> `/report/:id`.
 */
export function normalizePath(pathname: string): string {
  const cleaned = pathname
    .split("/")
    .map((segment) => (segment.length >= 12 && /\d/.test(segment) ? ":id" : segment))
    .join("/");
  return (cleaned || "/").slice(0, 200);
}

/** Error codes meaning "the events table isn't there / isn't writable" — stop retrying. */
function isSetupError(error: { code?: string; message?: string }): boolean {
  return (
    error.code === "42P01" || // undefined_table
    error.code === "PGRST205" || // table not in PostgREST schema cache
    error.code === "42501" // insufficient_privilege
  );
}

async function send(name: string, properties: Record<string, unknown>, path: string): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession();
    const { error } = await supabase.from("user_events").insert({
      user_id: data.session?.user.id ?? null,
      session_id: getSessionId(),
      event_name: name,
      path,
      properties,
    });
    if (error) {
      if (isSetupError(error)) disabled = true;
      return;
    }
    consecutiveFailures = 0;
  } catch {
    consecutiveFailures += 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) disabled = true;
  }
}

/**
 * Records one product event. Event names are snake_case (the table enforces
 * `^[a-z][a-z0-9_]{1,47}$`). Returns immediately; never throws.
 */
export function trackEvent(
  name: string,
  properties: Record<string, unknown> = {},
  path?: string,
): void {
  if (disabled || typeof window === "undefined") return;
  void send(name, properties, path ?? normalizePath(window.location.pathname));
}

export function trackPageView(pathname: string): void {
  const path = normalizePath(pathname);
  trackEvent("page_view", {}, path);
}
