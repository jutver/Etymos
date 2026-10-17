import { useEffect, useState } from "react";
import { cn, type AnnouncementKind, type AnnouncementLanguage, type AnnouncementSeverity, type AnnouncementState } from "@etymos/shared";
import { t, tr } from "../../lib/i18n";

export const KIND_LABELS: Record<AnnouncementKind, string> = {
  banner: tr("Top bar"),
  popup: tr("Pop-up"),
  maintenance: tr("Maintenance"),
};

export const SEVERITY_LABELS: Record<AnnouncementSeverity, string> = {
  info: tr("Info"),
  success: tr("Success"),
  warning: tr("Warning"),
  error: tr("Critical"),
};

/** Same colours as the site's top bar, in the admin's tokens. */
export const SEVERITY_BAR: Record<AnnouncementSeverity, string> = {
  info: "border-accent/25 bg-accent-bg text-accent",
  success: "border-success/30 bg-success-bg text-success",
  warning: "border-warning/30 bg-warning-bg text-warning",
  error: "border-destructive/30 bg-destructive-bg text-destructive",
};

export const STATE_LABELS: Record<AnnouncementState, string> = {
  live: tr("Live"),
  scheduled: tr("Scheduled"),
  ended: tr("Ended"),
  off: tr("Off"),
};

export const STATE_TONES = {
  live: "success",
  scheduled: "info",
  ended: "neutral",
  off: "neutral",
} as const;

/** What the site's maintenance page says when both text boxes are blank, in
 * each site language (the preview shows the language picked there, not the
 * admin's own). Keep in step with MaintenanceGate in apps/web. */
export const DEFAULT_MAINTENANCE_TEXT: Record<AnnouncementLanguage, { title: string; message: string }> = {
  en: {
    title: "We'll be back soon",
    message: "Etymos is down for maintenance while we make some improvements. Please come back a little later.",
  },
  vi: {
    title: "Chúng tôi sẽ sớm trở lại",
    message: "Etymos đang tạm dừng để bảo trì và nâng cấp. Bạn vui lòng quay lại sau ít phút nhé.",
  },
};

/** ISO -> value for <input type="datetime-local"> in this browser's time zone. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** <input type="datetime-local"> value -> ISO, or null when empty/invalid. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Re-renders every `ms` so time-based labels stay current. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

/** Same ticking countdown as the site's top bar. */
export function Countdown({ to, className }: { to: string; className?: string }) {
  const now = useNow(1000);
  const total = Math.max(0, Math.floor((Date.parse(to) - now) / 1000));
  const d = Math.floor(total / 86400);
  const units: [number, string][] = [
    ...(d > 0 ? ([[d, t("d")]] as [number, string][]) : []),
    [Math.floor((total % 86400) / 3600), t("h")],
    [Math.floor((total % 3600) / 60), t("m")],
    [total % 60, t("s")],
  ];
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {units.map(([value, unit]) => (
        <span key={unit} className="inline-flex items-baseline gap-0.5 rounded-md bg-white/70 px-1.5 py-0.5 tabular-nums">
          <span className="font-bold">{String(value).padStart(2, "0")}</span>
          <span className="text-[0.7em] font-semibold opacity-70">{unit}</span>
        </span>
      ))}
    </span>
  );
}
