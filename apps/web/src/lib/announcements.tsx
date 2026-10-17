import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  announcementState,
  nextAnnouncementChange,
  supabase,
  type Announcement,
} from "@etymos/shared";

/** How often to look for announcements an admin just switched on (maintenance included). */
const REFRESH_MS = 60_000;

interface AnnouncementsValue {
  /** Latest live banner, if any. */
  banner: Announcement | null;
  /** Latest live pop-up, if any. */
  popup: Announcement | null;
  /** Live maintenance: the site is locked for everyone but admins. */
  maintenance: Announcement | null;
  /** Maintenance switched on with a start time still ahead. */
  upcomingMaintenance: Announcement | null;
}

const EMPTY: AnnouncementsValue = { banner: null, popup: null, maintenance: null, upcomingMaintenance: null };
const AnnouncementsContext = createContext<AnnouncementsValue>(EMPTY);

/** Loads switched-on announcements once for the whole app, refreshes them
 * every minute and when the tab comes back, and re-evaluates exactly when a
 * scheduled one starts or ends. */
export function AnnouncementsProvider({ children }: { children: ReactNode }) {
  const [rows, setRows] = useState<Announcement[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      supabase
        .from("announcements")
        .select("*")
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .then(({ data, error }) => {
          if (cancelled) return;
          if (error) {
            console.error("Failed to load announcements", error);
            return;
          }
          setRows((data ?? []) as Announcement[]);
          setNow(Date.now());
        });
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

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
    return { banner: live("banner"), popup: live("popup"), maintenance: live("maintenance"), upcomingMaintenance: upcoming ?? null };
  }, [rows, now]);

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
