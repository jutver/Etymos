import { Coins, GraduationCap, Sparkle, Warning } from "@phosphor-icons/react";
import { useAppStore } from "../lib/store";
import type { BalanceSource } from "../lib/store";
import { cn } from "@etymos/shared";
import { Link } from "react-router-dom";
import { t } from "../lib/i18n";

const SOURCE_ICON: Record<BalanceSource, typeof Coins> = {
  plan: GraduationCap,
  standard: Coins,
  premium: Sparkle,
};

/** Renders all three independent balances (plan allowance, standard credits,
 * premium credits) as a row of pills. When `interactive` (default), clicking
 * one calls `setSelectedBalance` so the Upload screen (and anywhere else that
 * reads `selectedBalance`) knows which bucket to spend from. Pass
 * `interactive={false}` for placements that are display-only (nav bar, My
 * Plan) — those render plain non-clickable pills with no darkened/selected
 * state, since selection only actually matters on the Upload screen. */
export function UsageMeter({ compact = false, interactive = true }: { compact?: boolean; interactive?: boolean }) {
  const balances = useAppStore((s) => s.balances());
  const selectedBalance = useAppStore((s) => s.selectedBalance);
  const setSelectedBalance = useAppStore((s) => s.setSelectedBalance);

  const allZero = balances.every((b) => b.remaining <= 0);

  return (
    <div className="flex flex-col gap-1.5">
      <div className={cn("flex flex-wrap items-center gap-1.5", compact && "gap-1")}>
        {balances.map((b) => {
          const Icon = SOURCE_ICON[b.source];
          const selected = interactive && b.source === selectedBalance;
          const zero = b.remaining <= 0;
          const Tag = interactive ? "button" : "div";

          return (
            <Tag
              key={b.source}
              {...(interactive
                ? { type: "button" as const, "aria-pressed": selected, onClick: () => setSelectedBalance(b.source) }
                : {})}
              title={t(b.label)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border font-semibold transition-colors",
                compact ? "px-2.5 py-1 text-[0.6875rem]" : "px-3.5 py-1.5 text-xs",
                selected
                  ? "border-brand-500 bg-brand-100/40 text-brand-700"
                  : zero
                    ? "border-line bg-surface-tint text-ink-400" + (interactive ? " hover:border-brand-300" : "")
                    : "border-line bg-white text-ink-600" +
                      (interactive ? " hover:border-brand-300 hover:text-ink-800" : ""),
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
              {!compact && <span className="font-medium opacity-70">{t(b.label)}</span>}
            </Tag>
          );
        })}
      </div>
      {allZero && !compact && (
        <Link to="/pricing" className="w-fit text-xs font-semibold text-brand-600 underline underline-offset-2">
          {t("Upgrade or buy credits")}</Link>
      )}
    </div>
  );
}
