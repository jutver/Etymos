// Dismissible banner for admin-authored announcements. Fetches the most
// recent active row from `announcements` (is_active = true, within the
// starts_at/ends_at window) — RLS policy `announcements_select_all` makes
// this readable signed out too, so it's mounted above both PublicShell and
// AppShell in App.tsx.
import { useEffect, useState } from "react";
import { CheckCircle, Info, Warning, X, XCircle } from "@phosphor-icons/react";
import { supabase, cn } from "@etymos/shared";

type AnnouncementSeverity = "info" | "warning" | "success" | "error";

interface AnnouncementRow {
  id: string;
  message: string;
  severity: AnnouncementSeverity;
  created_at: string;
}

const DISMISSED_KEY = "etymos-dismissed-announcements";

function getDismissedIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function persistDismissedId(id: string) {
  if (typeof window === "undefined") return;
  const ids = getDismissedIds();
  ids.add(id);
  window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]));
}

const severityStyles: Record<AnnouncementSeverity, string> = {
  info: "bg-brand-100 border-brand-300 text-brand-700",
  success: "bg-success-bg border-success/30 text-success",
  warning: "bg-severity-moderate-bg border-severity-moderate-line text-severity-moderate",
  error: "bg-severity-high-bg border-severity-high-line text-severity-high",
};

const severityIcons: Record<AnnouncementSeverity, typeof Info> = {
  info: Info,
  success: CheckCircle,
  warning: Warning,
  error: XCircle,
};

export function AnnouncementBanner() {
  const [announcement, setAnnouncement] = useState<AnnouncementRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    const nowIso = new Date().toISOString();
    supabase
      .from("announcements")
      .select("id, message, severity, created_at")
      .eq("is_active", true)
      .or(`starts_at.is.null,starts_at.lte.${nowIso}`)
      .or(`ends_at.is.null,ends_at.gte.${nowIso}`)
      .order("created_at", { ascending: false })
      .limit(1)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("Failed to load announcements", error);
          return;
        }
        const row = (data ?? [])[0] as AnnouncementRow | undefined;
        if (row && !getDismissedIds().has(row.id)) {
          setAnnouncement(row);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!announcement) return null;

  function dismiss() {
    if (!announcement) return;
    persistDismissedId(announcement.id);
    setAnnouncement(null);
  }

  const Icon = severityIcons[announcement.severity];

  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-3 border-b px-5 py-2.5 text-sm font-medium sm:px-8",
        severityStyles[announcement.severity],
      )}
    >
      <Icon size={17} weight="fill" className="shrink-0" />
      <p className="flex-1">{announcement.message}</p>
      <button
        onClick={dismiss}
        aria-label="Dismiss announcement"
        className="shrink-0 rounded-full p-1 transition-colors hover:bg-black/5"
      >
        <X size={15} />
      </button>
    </div>
  );
}
