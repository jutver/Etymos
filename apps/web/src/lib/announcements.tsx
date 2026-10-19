import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  announcementState,
  nextAnnouncementChange,
  supabase,
  type Announcement,
} from "@etymos/shared";
import { useAuth } from "./auth";

/** How often to look for announcements an admin just switched on (maintenance included). */
const REFRESH_MS = 60_000;
/** Give up waiting for the first load after this, so a hung request can't
 * keep the boot splash up forever. */
const FIRST_LOAD_TIMEOUT_MS = 8_000;

interface AnnouncementsValue {
  /** Latest live banner, if any. */
  banner: Announcement | null;
  /** Latest live pop-up, if any. */
  popup: Announcement | null;
  /** Live maintenance: the site is locked for everyone but admins. */
  maintenance: Announcement | null;
  /** Maintenance switched on with a start time still ahead. */
  upcomingMaintenance: Announcement | null;
  /** The first fetch has finished (or failed, or timed out). Until then
   * `maintenance` being null means "unknown", not "off". */
  loaded: boolean;
}

const EMPTY: AnnouncementsValue = { banner: null, popup: null, maintenance: null, upcomingMaintenance: null, loaded: false };
const AnnouncementsContext = createContext<AnnouncementsValue>(EMPTY);

/** Loads the switched-on announcements meant for this visitor once for the
 * whole app, refreshes them every minute, when the tab comes back and when
 * they sign in or out, and re-evaluates exactly when a scheduled one starts
 * or ends. */
export function AnnouncementsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [rows, setRows] = useState<Announcement[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      // Filtered by audience on the server: announcements aimed at someone
      // else aren't readable here at all.
      supabase
        .rpc("my_announcements")
        .then(({ data, error }) => {
          if (cancelled) return;
          setLoaded(true);
          if (error) {
            console.error("Failed to load announcements", error);
            return;
          }
          // Keep the same array when nothing changed, so a routine refresh
          // doesn't hand every consumer new objects.
          const next = (data ?? []) as Announcement[];
          setRows((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
          setNow(Date.now());
        });
    load();
    const giveUp = window.setTimeout(() => setLoaded(true), FIRST_LOAD_TIMEOUT_MS);
    const timer = window.setInterval(load, REFRESH_MS);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(giveUp);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [userId]);

  // Wake up when the next one starts or ends (setTimeout caps at ~24.8 days).
  useEffect(() => {
    const next = nextAnnouncementChange(rows, now);
    if (next === null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(next - now + 50, 2 ** 31 - 1));
    return () => window.clearTimeout(timer);
  }, [rows, now]);

  const value = useMemo<AnnouncementsValue>(() => {
    const live = (kind: Announcement["kind"]) => rows.find((a) => a.kind === kind && announcementState(a, now) === "live") ?? null;
    const upcoming = rows
      .filter((a) => a.kind === "maintenance" && announcementState(a, now) === "scheduled")
      .sort((a, b) => Date.parse(a.starts_at!) - Date.parse(b.starts_at!))[0];
    return { banner: live("banner"), popup: live("popup"), maintenance: live("maintenance"), upcomingMaintenance: upcoming ?? null, loaded };
  }, [rows, now, loaded]);

  return <AnnouncementsContext.Provider value={value}>{children}</AnnouncementsContext.Provider>;
}

export function useAnnouncements(): AnnouncementsValue {
  return useContext(AnnouncementsContext);
}

const DISMISSED_KEY = "etymos-dismissed-announcements";

/** Announcement ids this browser has closed. Storage can be unavailable
 * (private mode); then nothing is remembered. */
export function dismissedAnnouncements(): Set<string> {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function dismissAnnouncement(id: string): void {
  try {
    const ids = dismissedAnnouncements();
    ids.add(id);
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids].slice(-50)));
  } catch {
    // Not remembered; it shows again next visit.
  }
}
