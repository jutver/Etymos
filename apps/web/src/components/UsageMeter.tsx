import { Coins, GraduationCap, Sparkle, Warning } from "@phosphor-icons/react";
import { useAppStore } from "../lib/store";
import type { BalanceSource } from "../lib/store";
import { cn } from "@etymos/shared";
import { Link } from "react-router-dom";

const SOURCE_ICON: Record<BalanceSource, typeof Coins> = {
  plan: GraduationCap,
  standard: Coins,
  premium: Sparkle,
};

/** Renders all three independent balances (plan allowance, standard credits,
 * premium credits) as a row of selectable pills — clicking one calls
 * `setSelectedBalance` so the Upload screen (and anywhere else that reads
 * `selectedBalance`) knows which bucket to spend from. Replaces the old
 * single-balance display that only ever showed whichever bucket happened to
 * be nonzero. */
export function UsageMeter({ compact = false }: { compact?: boolean }) {
  const balances = useAppStore((s) => s.balances());
  const selectedBalance = useAppStore((s) => s.selectedBalance);
  const setSelectedBalance = useAppStore((s) => s.setSelectedBalance);

  const allZero = balances.every((b) => b.remaining <= 0);

  return (
    <div className="flex flex-col gap-1.5">
      <div className={cn("flex flex-wrap items-center gap-1.5", compact && "gap-1")}>
        {balances.map((b) => {
          const Icon = SOURCE_ICON[b.source];
          const selected = b.source === selectedBalance;
          const zero = b.remaining <= 0;

          return (
            <button
              key={b.source}
              type="button"
              aria-pressed={selected}
              onClick={() => setSelectedBalance(b.source)}
              title={b.label}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border font-semibold transition-colors",
                compact ? "px-2.5 py-1 text-[0.6875rem]" : "px-3.5 py-1.5 text-xs",
                selected
                  ? "border-brand-500 bg-brand-100/40 text-brand-700"
                  : zero
                    ? "border-line bg-surface-tint text-ink-400 hover:border-brand-300"
                    : "border-line bg-white text-ink-600 hover:border-brand-300 hover:text-ink-800",
              )}
            >
              {zero ? (
                <Warning
                  size={compact ? 12 : 14}
                  weight="fill"
                  className={selected ? "text-severity-high" : undefined}
                />
              ) : (
                <Icon size={compact ? 12 : 14} weight={selected ? "fill" : "regular"} />
              )}
              <span>{b.remaining}</span>
              {!compact && <span className="font-medium opacity-70">{b.label}</span>}
            </button>
          );
        })}
      </div>
      {allZero && !compact && (
        <Link to="/pricing" className="w-fit text-xs font-semibold text-brand-600 underline underline-offset-2">
          Upgrade or buy credits
        </Link>
      )}
    </div>
  );
}
