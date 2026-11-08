import { Check, GraduationCap, Star } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type { BillingCycle, PlanDefinition } from "@etymos/shared";
import { annualSavingsPercent, formatVND } from "@etymos/shared";
import { useAppStore } from "../lib/store";
import { Button } from "./ui/Button";
import { RollingNumber } from "./ui/RollingNumber";
import { cn } from "@etymos/shared";
import { t } from "../lib/i18n";

/**
 * Classes for the grid that holds plan cards. On wide screens each card's
 * parts (heading, price, notes, button, features) share rows with the cards
 * beside it, so the buttons sit level whatever the notes above them say.
 */
export const PLAN_GRID_CLASS =
  "grid grid-cols-1 gap-6 lg:grid-cols-3 lg:grid-rows-[repeat(5,auto)] lg:gap-x-5 lg:gap-y-0";

/** Placeholders in a PLAN_GRID_CLASS grid take a card's five rows. */
export const PLAN_GRID_ITEM_CLASS = "lg:row-span-5";

export function PlanCard({
  plan,
  billingCycle,
  discountedPrice,
}: {
  plan: PlanDefinition;
  billingCycle: BillingCycle;
  /** If set (and lower than the base price), rendered alongside the struck-through original price. */
  discountedPrice?: number;
}) {
  const navigate = useNavigate();
  const currentPlan = useAppStore((s) => s.plan);
  const studentVerified = useAppStore((s) => s.studentVerified);
  const selectCheckoutItem = useAppStore((s) => s.selectCheckoutItem);
  const isCurrent = currentPlan === plan.id;
  // The paid plan you're on can be renewed: paying again adds a term to the end.
  const canRenew = isCurrent && plan.id !== "free";
  const price = billingCycle === "monthly" ? plan.priceMonthly : plan.priceAnnual;
  const hasDiscount = discountedPrice !== undefined && discountedPrice < price;
  const needsVerification = plan.requiresVerification && !studentVerified;

  function handleSelect() {
    if (plan.id === "free" || (isCurrent && !canRenew)) {
      navigate("/upload");
      return;
    }
    selectCheckoutItem({
      kind: "plan",
      plan: plan.id as "student" | "professional",
      billingCycle,
    });
    if (needsVerification) {
      navigate("/verify-student");
      return;
    }
    navigate("/checkout");
  }

  return (
    <div
      className={cn(
        "studio-plan studio-card relative flex flex-col rounded-[var(--radius-card-lg)] border bg-white p-7",
        // Five rows shared with the neighbouring cards (see PLAN_GRID_CLASS).
        "lg:row-span-5 lg:grid lg:grid-rows-subgrid lg:gap-0",
        plan.mostPopular
          ? "border-brand-500 shadow-[0_20px_48px_-16px_rgba(30,79,196,0.35)]"
          : "border-line shadow-[var(--shadow-card)]",
      )}
    >
      {plan.mostPopular && (
        <span className="absolute -top-3.5 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full brand-gradient px-3.5 py-1.5 text-xs font-bold text-white shadow-[0_6px_16px_-4px_rgba(30,79,196,0.5)]">
          <Star size={12} weight="fill" />
          {t("Most popular")}</span>
      )}

      <div>
        <h3 className="text-h3 font-bold text-navy-900">{t(plan.name)}</h3>
        <p className="mt-1.5 min-h-[2.5rem] text-sm text-ink-500">{t(plan.tagline)}</p>
      </div>

      <div className="mt-6 flex items-baseline gap-1.5">
        {hasDiscount && (
          <span className="text-lg font-semibold text-ink-400 line-through">{formatVND(price)}</span>
        )}
        {/* Digits roll to the new price when switching monthly / annual. */}
        <RollingNumber
          className={cn("text-3xl font-extrabold tracking-tight", hasDiscount ? "text-success" : "text-navy-900")}
          value={(hasDiscount ? discountedPrice! : price) === 0 ? "0 đ" : formatVND(hasDiscount ? discountedPrice! : price)}
        />
        {price > 0 && (
          <span className="text-sm font-medium text-ink-500">
            {billingCycle === "monthly" ? t("/mo") : t("/yr")}
          </span>
        )}
      </div>

      <div className="mt-1">
        {/* Always takes its line, so switching to annual doesn't push anything
            down; it fades and rises in when annual is picked. */}
        <p
          className={cn(
            "h-5 text-xs font-medium leading-5 text-success transition-[opacity,transform] duration-500 ease-out motion-reduce:transition-none",
            plan.id === "free" || billingCycle !== "annual" ? "translate-y-1.5 opacity-0" : "translate-y-0 opacity-100 delay-150",
          )}
          aria-hidden={plan.id === "free" || billingCycle !== "annual"}
        >
          {plan.id !== "free" &&
            t("Save {{percent}}% vs. monthly", { percent: annualSavingsPercent(plan.priceMonthly, plan.priceAnnual) })}
        </p>
        {needsVerification && !isCurrent && (
          <p className="mt-1.5 flex items-center gap-1.5 rounded-lg bg-surface-tint px-3 py-2 text-xs font-medium text-ink-600">
            <GraduationCap size={14} weight="fill" className="shrink-0 text-brand-500" />
            {t("Requires student verification before checkout")}</p>
        )}
      </div>

      <Button
        onClick={handleSelect}
        variant={plan.mostPopular ? "primary" : isCurrent ? "outline" : "secondary"}
        fullWidth
        className="mt-6 self-start"
        disabled={isCurrent && !canRenew}
      >
        {canRenew
          ? t("Renew {{name}}", { name: t(plan.name) })
          : isCurrent
          ? t("Current plan")
          : plan.id === "free"
            ? t("Start for free")
            : needsVerification
              ? t("Verify & choose plan")
              : t("Choose {{name}}", { name: plan.name })}
      </Button>

      <ul className="mt-7 flex flex-1 flex-col gap-3 lg:self-start">
        {plan.features.map((f) => (
          <li key={f} className="flex items-start gap-2.5 text-sm text-ink-700">
            <Check size={16} weight="bold" className="mt-0.5 shrink-0 text-brand-500" />
            <span>{t(f)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
