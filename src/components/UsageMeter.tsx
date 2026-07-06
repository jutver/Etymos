import { Coins, Sparkle, Warning } from "@phosphor-icons/react";
import { useAppStore, FREE_CHECKS_LIMIT, planLabel } from "../lib/store";
import { cn } from "../lib/cn";
import { Link } from "react-router-dom";

export function UsageMeter({ compact = false }: { compact?: boolean }) {
  const plan = useAppStore((s) => s.plan);
  const mode = useAppStore((s) => s.balanceMode());
  const remaining = useAppStore((s) => s.remaining());
  const freeChecksUsed = useAppStore((s) => s.freeChecksUsed);

  if (mode === "unlimited") {
    return (
      <div
        className={cn(
          "inline-flex items-center gap-2 rounded-full border border-brand-300/60 bg-brand-100 font-semibold text-brand-700",
          compact ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm",
        )}
      >
        <Sparkle size={compact ? 13 : 15} weight="fill" />
        {planLabel(plan)} · Unlimited
      </div>
    );
  }

  const low = remaining <= 1;
  const zero = remaining <= 0;

  if (mode === "credits") {
    return (
      <div
        className={cn(
          "inline-flex items-center gap-2 rounded-full border font-semibold",
          zero
            ? "border-severity-high-line bg-severity-high-bg text-severity-high"
            : low
              ? "border-severity-moderate-line bg-severity-moderate-bg text-severity-moderate"
              : "border-line bg-surface-tint text-ink-700",
          compact ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm",
        )}
      >
        <Coins size={compact ? 13 : 15} weight="fill" />
        {remaining} credit{remaining === 1 ? "" : "s"} left
        {zero && !compact && (
          <Link to="/pricing" className="ml-1 underline underline-offset-2">
            Top up
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2.5">
      <div
        className={cn(
          "inline-flex items-center gap-2 rounded-full border font-semibold",
          zero
            ? "border-severity-high-line bg-severity-high-bg text-severity-high"
            : low
              ? "border-severity-moderate-line bg-severity-moderate-bg text-severity-moderate"
              : "border-line bg-surface-tint text-ink-700",
          compact ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm",
        )}
      >
        {(low || zero) && <Warning size={compact ? 13 : 15} weight="fill" />}
        {remaining} of {FREE_CHECKS_LIMIT} checks left this month
      </div>
      {!compact && (
        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-muted">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              zero ? "bg-severity-high" : low ? "bg-severity-moderate" : "bg-brand-500",
            )}
            style={{ width: `${(freeChecksUsed / FREE_CHECKS_LIMIT) * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}
