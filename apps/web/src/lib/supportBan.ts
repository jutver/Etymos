// A support-banned account's note in this browser, so the signed-out Contact
// form stays closed after signing out. The backend hands out the token (signed,
// naming the account) and re-checks the ban on every request, so the note can't
// block anyone the ban no longer covers. Clearing site data removes it; the
// backend still matches the ban by email address.
import { ApiError, getDeviceSupportStanding, getSupportStanding } from "./api";

const KEY = "etymos.supportBan";

export interface SupportBanNote {
  token: string;
  /** End of a temporary ban; null when permanent. */
  until: string | null;
}

export interface SupportBlock {
  until: string | null;
  /** The admin's message; only known while signed in. */
  reason: string | null;
}

function read(): SupportBanNote | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const note = JSON.parse(raw) as SupportBanNote;
    if (typeof note?.token !== "string") return null;
    if (note.until && new Date(note.until).getTime() <= Date.now()) {
      window.localStorage.removeItem(KEY);
      return null;
    }
    return note;
  } catch {
    return null;
  }
}

function save(token: string | null | undefined, until: string | null) {
  if (!token) return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ token, until } satisfies SupportBanNote));
  } catch {
    // Storage blocked: the email-address check still applies.
  }
}

function clear() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // nothing stored
  }
}

/** The note's token, for the signed-out form to send along. */
export function supportBanToken(): string | undefined {
  return read()?.token ?? undefined;
}

/** For a 403 support_banned response: keeps the note when it carries one and
 * returns the block to show. Null for any other error. */
export function rememberSupportBan(err: unknown): SupportBlock | null {
  if (!(err instanceof ApiError) || err.message !== "support_banned") return null;
  const detail = err.detail as
    | { device_token?: string | null; until?: string | null; reason?: string | null }
    | undefined;
  save(detail?.device_token, detail?.until ?? null);
  return { until: detail?.until ?? null, reason: detail?.reason ?? null };
}

/** Signed in: asks the backend and keeps the note in step. Only this
 * account's own note is cleared when it isn't banned (another account
 * signing in on the same browser leaves it). Signed out: checks the note
 * that's here, if any. Null when contacting support is allowed. */
export async function checkSupportBlock(userId: string | null): Promise<SupportBlock | null> {
  if (userId) {
    const standing = await getSupportStanding();
    if (standing.banned) {
      save(standing.device_token, standing.until);
      return { until: standing.until, reason: standing.reason };
    }
    const note = read();
    if (note && note.token.startsWith(userId.replace(/-/g, "") + ".")) clear();
    return null;
  }
  const note = read();
  if (!note) return null;
  try {
    const { banned } = await getDeviceSupportStanding(note.token);
    if (banned) return { until: note.until, reason: null };
    clear();
    return null;
  } catch {
    // Can't reach the backend: go by the note; the backend checks on send anyway.
    return { until: note.until, reason: null };
  }
}
