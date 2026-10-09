import type { SupportCategory, SupportStatus } from "../../lib/supportApi";
import { tr } from "../../lib/i18n";

export const CATEGORY_LABELS: Record<SupportCategory, string> = {
  billing: tr("Billing"),
  account: tr("Account"),
  checks: tr("Checks"),
  bug: tr("Bug"),
  other: tr("Other"),
};

/** Worded from the team's side: "open" means it's waiting on us. */
export const STATUS_LABELS: Record<SupportStatus, string> = {
  open: tr("Open"),
  pending: tr("Waiting on user"),
  resolved: tr("Resolved"),
  closed: tr("Closed"),
};

export type BadgeTone = "neutral" | "accent" | "destructive" | "warning" | "info" | "success";

export function statusTone(status: SupportStatus): BadgeTone {
  if (status === "open") return "accent";
  if (status === "pending") return "warning";
  if (status === "resolved") return "success";
  return "neutral";
}

/** "3h", "2d" — how long ago, compact for table cells. */
export function ago(iso: string | null): string {
  if (!iso) return "—";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
