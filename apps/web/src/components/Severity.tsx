import type { Severity, DocStatus } from "@etymos/shared";
import { cn } from "@etymos/shared";

export const severityConfig: Record<
  Severity,
  { label: string; text: string; bg: string; line: string; dot: string }
> = {
  high: {
    label: "High match",
    text: "text-severity-high",
    bg: "bg-severity-high-bg",
    line: "border-severity-high-line",
    dot: "bg-severity-high",
  },
  moderate: {
    label: "Moderate match",
    text: "text-severity-moderate",
    bg: "bg-severity-moderate-bg",
    line: "border-severity-moderate-line",
    dot: "bg-severity-moderate",
  },
  low: {
    label: "Common phrasing",
    text: "text-severity-low",
    bg: "bg-severity-low-bg",
    line: "border-severity-low-line",
    dot: "bg-severity-low",
  },
};

export function SeverityTag({ severity, className }: { severity: Severity; className?: string }) {
  const c = severityConfig[severity];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold",
        c.text,
        c.bg,
        c.line,
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", c.dot)} />
      {c.label}
    </span>
  );
}

export function statusFromScore(score: number): DocStatus {
  if (score < 15) return "clean";
  if (score < 30) return "low";
  if (score < 50) return "moderate";
  return "high";
}

const statusConfig: Record<DocStatus, { label: string; text: string; bg: string; line: string }> = {
  clean: { label: "Clean", text: "text-success", bg: "bg-success-bg", line: "border-success/20" },
  low: {
    label: "Low similarity",
    text: "text-severity-low",
    bg: "bg-severity-low-bg",
    line: "border-severity-low-line",
  },
  moderate: {
    label: "Moderate similarity",
    text: "text-severity-moderate",
    bg: "bg-severity-moderate-bg",
    line: "border-severity-moderate-line",
  },
  high: {
    label: "High similarity",
    text: "text-severity-high",
    bg: "bg-severity-high-bg",
    line: "border-severity-high-line",
  },
};

export function StatusPill({ status, className }: { status: DocStatus; className?: string }) {
  const c = statusConfig[status];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold",
        c.text,
        c.bg,
        c.line,
        className,
      )}
    >
      {c.label}
    </span>
  );
}

export function SimilarityBadge({ score, size = "md" }: { score: number; size?: "sm" | "md" | "lg" }) {
  const status = statusFromScore(score);
  const c = statusConfig[status];
  const dims =
    size === "lg" ? "size-20 text-2xl" : size === "sm" ? "size-11 text-sm" : "size-14 text-lg";
  return (
    <div className="inline-flex items-center gap-3">
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full border-[3px] font-bold",
          dims,
          c.text,
          c.bg,
          c.line,
        )}
      >
        {score}%
      </div>
      <div className="flex flex-col">
        <span className="text-caption font-medium text-ink-500">Similarity Score</span>
        <span className={cn("text-sm font-semibold", c.text)}>{c.label}</span>
      </div>
    </div>
  );
}
