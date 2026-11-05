/**
 * Announcements, shared by the site (which shows them) and the admin app
 * (which writes them). Schema: supabase/migrations/20261017000000_announcements_overhaul.sql
 * 20261018000000_announcements_bilingual.sql, 20261020000000_announcement_audience.sql
 * and 20261106000000_popup_placement_and_button.sql.
 */
import { supabase } from "./supabase";

export type AnnouncementKind = "banner" | "popup" | "maintenance";
export type AnnouncementSeverity = "info" | "warning" | "success" | "error";
/** Who sees a top bar or pop-up. Maintenance is always "everyone". */
export type AnnouncementAudience = "everyone" | "signed_in" | "plans" | "emails";
/** Pop-up only: the signed-in home page, the signed-out landing page, or both. */
export type PopupPlacement = "home" | "landing" | "both";

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
  audience: AnnouncementAudience;
  /** Plan ids ("free", "student", "professional") when audience is "plans", else null. */
  audience_plans: string[] | null;
  /** Pop-up only: which page it opens on. Landing needs audience "everyone". */
  popup_placement: PopupPlacement;
  /** Pop-up only: button text; null = "Got it" (see announcementButton). */
  button_label: string | null;
  button_label_vi: string | null;
  /** Pop-up only: where the button goes (site path or http(s) address); null = it just closes. */
  button_url: string | null;
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

/** Same rule as the database check on button_url: a path on the site
 * ("/pricing") or an http(s) address. Nothing that could run script. */
export function isAnnouncementLinkValid(url: string): boolean {
  return url.length <= 2000 && /^(https?:\/\/[^\s/]+\S*|\/([^/\s]\S*)?)$/.test(url);
}

/** The pop-up button's text in `lang`, falling back to the other language;
 * null when neither is set, so the caller shows its own "Got it". */
export function announcementButtonLabel(
  a: Pick<Announcement, "button_label" | "button_label_vi">,
  lang: AnnouncementLanguage,
): string | null {
  const [first, second] = lang === "vi" ? [a.button_label_vi, a.button_label] : [a.button_label, a.button_label_vi];
  return first?.trim() || second?.trim() || null;
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
