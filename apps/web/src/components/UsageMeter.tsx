import { useState } from "react";
import { ArrowRight, CaretDown, Coins, GraduationCap, Sparkle } from "@phosphor-icons/react";
import { planLabel, useAppStore } from "../lib/store";
import type { BalanceSource } from "../lib/store";
import { cn } from "@etymos/shared";
import { Link } from "react-router-dom";
import { t } from "../lib/i18n";

const SOURCE_ICON: Record<BalanceSource, typeof Coins> = {
  plan: GraduationCap,
  standard: Coins,
  premium: Sparkle,
};

/** Each balance keeps its own color everywhere so users can tell them apart
 * at a glance: blue for plan checks, amber for standard, violet for premium. */
const SOURCE_COLOR: Record<BalanceSource, { light: string; dark: string }> = {
  plan: { light: "text-brand-600", dark: "bg-brand-400/15 text-brand-300" },
  standard: { light: "text-amber-600", dark: "bg-amber-400/15 text-amber-300" },
  premium: { light: "text-violet-600", dark: "bg-violet-400/15 text-violet-300" },
};

/** Renders all three independent balances (plan allowance, standard credits,
 * premium credits). The default `pills` variant is a row of pills; when
 * `interactive` (default), clicking one calls `setSelectedBalance` so the
 * Upload screen (and anywhere else that reads `selectedBalance`) knows which
 * bucket to spend from. Pass `interactive={false}` for display-only
 * placements (nav bar, My Plan). The `sidebar` variant is a labelled list for
 * the navy desktop sidebar; it is always display-only and can be collapsed
 * to a single row of numbers. */
export function UsageMeter({
  compact = false,
  interactive = true,
  variant = "pills",
}: {
  compact?: boolean;
  interactive?: boolean;
  variant?: "pills" | "sidebar";
}) {
  const balances = useAppStore((s) => s.balances());
  const selectedBalance = useAppStore((s) => s.selectedBalance);
  const setSelectedBalance = useAppStore((s) => s.setSelectedBalance);

  const allZero = balances.every((b) => b.remaining <= 0);

  if (variant === "sidebar") return <SidebarBalance />;

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
              title={`${t(b.label)}: ${b.remaining}`}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border font-semibold transition-colors",
                compact ? "px-2.5 py-1 text-xs" : "px-3.5 py-1.5 text-xs",
                selected
                  ? "border-brand-500 bg-brand-100/40 text-brand-700"
                  : zero
                    ? "border-line bg-surface-tint text-ink-400" + (interactive ? " hover:border-brand-300" : "")
                    : "border-line bg-white text-ink-600" +
                      (interactive ? " hover:border-brand-300 hover:text-ink-800" : ""),
              )}
            >
              <Icon
                size={compact ? 14 : 15}
                weight="fill"
                className={cn(SOURCE_COLOR[b.source].light, zero && "opacity-50")}
              />
              <span className="tabular-nums">{b.remaining}</span>
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

function BalanceIcon({ source }: { source: BalanceSource }) {
  const Icon = SOURCE_ICON[source];
  return (
    <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-md", SOURCE_COLOR[source].dark)}>
      <Icon size={15} weight="fill" />
    </span>
  );
}

const SIDEBAR_COLLAPSED_KEY = "etymos.balanceCollapsed";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Sidebar balance box: a Plan section above a Credits section. Collapsed, it
 * shrinks to one row of colored icons with their numbers, plan first and the
 * credits after a divider. The choice is remembered in this browser. */
function SidebarBalance() {
  const balances = useAppStore((s) => s.balances());
  const plan = useAppStore((s) => s.plan);
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const toggle = () => {
    setCollapsed((was) => {
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, was ? "0" : "1");
      } catch {
        // Not remembered (private mode or storage blocked); still toggles.
      }
      return !was;
    });
  };

  const planBalance = balances.find((b) => b.source === "plan");
  const creditBalances = balances.filter((b) => b.source !== "plan");
  const creditsEmpty = creditBalances.every((b) => b.remaining <= 0);
  const sectionLabel = "text-[0.6875rem] font-semibold uppercase tracking-wider text-white/50";

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-expanded={false}
        aria-label={t("Show balance details")}
        className="flex w-full items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-2.5 py-2 text-white transition-colors hover:bg-white/[0.08]"
      >
        {planBalance && (
          <>
            <BalanceChip source="plan" remaining={planBalance.remaining} label={t(planBalance.label)} />
            <span aria-hidden className="h-4 w-px bg-white/15" />
          </>
        )}
        {creditBalances.map((b) => (
          <BalanceChip key={b.source} source={b.source} remaining={b.remaining} label={t(b.label)} />
        ))}
        <CaretDown size={13} className="ml-auto shrink-0 rotate-180 text-white/50" />
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.04]">
      <div className="p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className={sectionLabel}>{t("Plan")}</span>
          <button
            type="button"
            onClick={toggle}
            aria-expanded
            aria-label={t("Hide balance details")}
            title={t("Hide balance details")}
            className="-m-1 flex size-6 items-center justify-center rounded-md text-white/50 transition-colors hover:bg-white/10 hover:text-white"
          >
            <CaretDown size={13} />
          </button>
        </div>
        {planBalance && (
          <div className={cn("flex items-center gap-2.5", planBalance.remaining <= 0 && "opacity-55")}>
            <BalanceIcon source="plan" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-white">{t("{{plan}} plan", { plan: planLabel(plan) })}</p>
              <p className="truncate text-[0.6875rem] text-white/55">{t("Checks left")}</p>
            </div>
            <span className="text-sm font-bold tabular-nums text-white">{planBalance.remaining}</span>
          </div>
        )}
      </div>

      <div className="border-t border-white/10 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className={sectionLabel}>{t("Credits")}</span>
          <Link
            to="/account/plan"
            className={cn(
              "inline-flex items-center gap-1 text-[0.6875rem] font-semibold transition-colors",
              creditsEmpty ? "text-brand-300 hover:text-white" : "text-white/50 hover:text-white",
            )}
          >
            {t("Get more")}
            <ArrowRight size={11} weight="bold" />
          </Link>
        </div>
        <ul className="flex flex-col gap-1">
          {creditBalances.map((b) => (
            <li
              key={b.source}
              title={t(b.label)}
              className={cn("flex items-center gap-2.5 py-1", b.remaining <= 0 && "opacity-55")}
            >
              <BalanceIcon source={b.source} />
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-white/75">
                {t(b.source === "standard" ? "Standard" : "Premium")}
              </span>
              <span className="text-sm font-bold tabular-nums text-white">{b.remaining}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function BalanceChip({ source, remaining, label }: { source: BalanceSource; remaining: number; label: string }) {
  const Icon = SOURCE_ICON[source];
  return (
    <span title={`${label}: ${remaining}`} className={cn("inline-flex items-center gap-1", remaining <= 0 && "opacity-55")}>
      <span className={cn("flex size-6 items-center justify-center rounded-md", SOURCE_COLOR[source].dark)}>
        <Icon size={13} weight="fill" />
      </span>
      <span className="text-xs font-bold tabular-nums">{remaining}</span>
    </span>
  );
}
