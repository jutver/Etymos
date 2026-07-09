import { Coins, Warning } from "@phosphor-icons/react";
import { useAppStore, planDocLimit } from "../lib/store";
import { cn } from "../lib/cn";
import { Link } from "react-router-dom";

export function UsageMeter({ compact = false }: { compact?: boolean }) {
  const plan = useAppStore((s) => s.plan);
  const mode = useAppStore((s) => s.balanceMode());
  const remaining = useAppStore((s) => s.remaining());
  const checksUsedThisPeriod = useAppStore((s) => s.checksUsedThisPeriod);
  const limit = planDocLimit(plan);

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
        {remaining} of {limit} checks left this month
      </div>
      {!compact && (
        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-muted">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              zero ? "bg-severity-high" : low ? "bg-severity-moderate" : "bg-brand-500",
            )}
            style={{ width: `${(checksUsedThisPeriod / limit) * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}
