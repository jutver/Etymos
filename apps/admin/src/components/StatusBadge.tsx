import { cn } from "@etymos/shared";
import { t } from "../lib/i18n";

type BadgeTone = "neutral" | "accent" | "destructive" | "warning" | "info" | "success";

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-surface-raised text-fg-muted",
  accent: "bg-accent-bg text-accent",
  destructive: "bg-destructive-bg text-destructive",
  warning: "bg-warning-bg text-warning",
  info: "bg-info-bg text-info",
  success: "bg-success-bg text-success",
};

/** `capitalize` (default) title-cases raw status values like "pending"; pass
 * false for labels that are already written as sentences. */
export function StatusBadge({
  label,
  tone = "neutral",
  capitalize = true,
}: {
  label: string;
  tone?: BadgeTone;
  capitalize?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-caption font-medium",
        capitalize && "capitalize",
        TONE_CLASSES[tone],
      )}
    >
      {t(label)}
    </span>
  );
}

export function roleTone(role: string): BadgeTone {
  return role === "admin" ? "accent" : "neutral";
}

export function moderationTone(status: string): BadgeTone {
  if (status === "removed") return "destructive";
  if (status === "flagged") return "warning";
  return "neutral";
}

export function docStatusTone(status: string): BadgeTone {
  if (status === "high") return "destructive";
  if (status === "moderate") return "warning";
  if (status === "low") return "info";
  return "accent";
}
