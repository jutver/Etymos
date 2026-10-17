/**
 * Announcements, shared by the site (which shows them) and the admin app
 * (which writes them). Schema: supabase/migrations/20261017000000_announcements_overhaul.sql
 * and 20261018000000_announcements_bilingual.sql.
 */
import { supabase } from "./supabase";

export type AnnouncementKind = "banner" | "popup" | "maintenance";
export type AnnouncementSeverity = "info" | "warning" | "success" | "error";

/** Icons a banner can show. Each app maps these to its icon components. */
export const ANNOUNCEMENT_ICONS = [
  "info",
  "warning",
  "success",
  "error",
  "megaphone",
  "gift",
  "tag",
  "percent",
  "lightning",
  "sparkle",
  "rocket",
  "clock",
  "calendar",
  "wrench",
  "heart",
] as const;
export type AnnouncementIcon = (typeof ANNOUNCEMENT_ICONS)[number];

export interface Announcement {
  id: string;
  kind: AnnouncementKind;
  /** English. */
  title: string | null;
  message: string;
  /** Vietnamese. */
  title_vi: string | null;
  message_vi: string;
  severity: AnnouncementSeverity;
  /** Banner only; null = no icon. */
  icon: AnnouncementIcon | null;
  /** Banner only: counts down to this moment, and the bar hides once it passes. */
  countdown_to: string | null;
  /** Popup only: object path in the public `announcement-images` bucket. */
  image_path: string | null;
  is_active: boolean;
  /** Null = from the moment it's switched on. */
  starts_at: string | null;
  /** Ignored for maintenance, which lasts until switched off. */
  ends_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const ANNOUNCEMENT_IMAGE_BUCKET = "announcement-images";

export function announcementImageUrl(path: string | null): string | null {
  if (!path) return null;
  return supabase.storage.from(ANNOUNCEMENT_IMAGE_BUCKET).getPublicUrl(path).data.publicUrl;
}

export type AnnouncementLanguage = "en" | "vi";

/** Title and message in `lang`. A blank field falls back to the other
 * language, so text written in one language still reaches everyone. */
export function announcementText(
  a: Pick<Announcement, "title" | "message" | "title_vi" | "message_vi">,
  lang: AnnouncementLanguage,
): { title: string; message: string } {
  const pick = (en: string | null, vi: string | null) => {
    const [first, second] = lang === "vi" ? [vi, en] : [en, vi];
    return first?.trim() || second?.trim() || "";
  };
  return { title: pick(a.title, a.title_vi), message: pick(a.message, a.message_vi) };
}

export type AnnouncementState = "off" | "scheduled" | "live" | "ended";

/** Where an announcement stands at `now`. */
export function announcementState(a: Announcement, now: number = Date.now()): AnnouncementState {
  if (!a.is_active) return "off";
  if (a.starts_at && Date.parse(a.starts_at) > now) return "scheduled";
  if (a.kind !== "maintenance" && a.ends_at && Date.parse(a.ends_at) <= now) return "ended";
  if (a.kind === "banner" && a.countdown_to && Date.parse(a.countdown_to) <= now) return "ended";
  return "live";
}

/** The next moment some announcement in `list` changes state, or null. */
export function nextAnnouncementChange(list: Announcement[], now: number = Date.now()): number | null {
  let next: number | null = null;
  for (const a of list) {
    if (!a.is_active) continue;
    const times = [a.starts_at, a.kind === "maintenance" ? null : a.ends_at, a.kind === "banner" ? a.countdown_to : null];
    for (const iso of times) {
      const at = iso ? Date.parse(iso) : NaN;
      if (at > now && (next === null || at < next)) next = at;
    }
  }
  return next;
}
