import { Check, GraduationCap, Star } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type { BillingCycle, PlanDefinition } from "@etymos/shared";
import { annualSavingsPercent, formatVND } from "@etymos/shared";
import { useAppStore } from "../lib/store";
import { Button } from "./ui/Button";
import { cn } from "@etymos/shared";
import { t } from "../lib/i18n";

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
  const price = billingCycle === "monthly" ? plan.priceMonthly : plan.priceAnnual;
  const hasDiscount = discountedPrice !== undefined && discountedPrice < price;
  const needsVerification = plan.requiresVerification && !studentVerified;

  function handleSelect() {
    if (plan.id === "free" || isCurrent) {
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
        plan.mostPopular
          ? "border-brand-500 shadow-[0_20px_48px_-16px_rgba(30,79,196,0.35)]"
          : "border-line shadow-[var(--shadow-card)]",
      )}
    >
      {plan.mostPopular && (
        <span className="absolute -top-3.5 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full brand-gradient px-3.5 py-1.5 text-xs font-bold text-white shadow-[0_6px_16px_-4px_rgba(30,79,196,0.5)]">
          <Star size={12} weight="fill" />
          {t("Most popular")}
        </span>
      )}

      <h3 className="text-h3 font-bold text-navy-900">{t(plan.name)}</h3>
      <p className="mt-1.5 min-h-[2.5rem] text-sm text-ink-500">{t(plan.tagline)}</p>

      <div className="mt-6 flex items-baseline gap-1.5">
        {hasDiscount && (
          <span className="text-lg font-semibold text-ink-400 line-through">{formatVND(price)}</span>
        )}
        <span className={cn("text-3xl font-extrabold tracking-tight", hasDiscount ? "text-success" : "text-navy-900")}>
          {(hasDiscount ? discountedPrice! : price) === 0 ? "0 đ" : formatVND(hasDiscount ? discountedPrice! : price)}
        </span>
        {price > 0 && (
          <span className="text-sm font-medium text-ink-500">
            /{billingCycle === "monthly" ? "mo" : "yr"}
          </span>
        )}
      </div>

      <div className="mt-1 min-h-[3.25rem]">
        {plan.id !== "free" && billingCycle === "annual" && (
          <p className="text-xs font-medium text-success">
            {t("Save {{percent}}% vs. monthly", { percent: annualSavingsPercent(plan.priceMonthly, plan.priceAnnual) })}
          </p>
        )}
        {needsVerification && !isCurrent && (
          <p
            className={cn(
              "flex items-center gap-1.5 rounded-lg bg-surface-tint px-3 py-2 text-xs font-medium text-ink-600",
              plan.id !== "free" && billingCycle === "annual" && "mt-1.5",
            )}
          >
            <GraduationCap size={14} weight="fill" className="shrink-0 text-brand-500" />
            {t("Requires student verification before checkout")}
          </p>
        )}
      </div>

      <Button
        onClick={handleSelect}
        variant={plan.mostPopular ? "primary" : isCurrent ? "outline" : "secondary"}
        fullWidth
        className="mt-6"
        disabled={isCurrent}
      >
        {isCurrent
          ? t("Current plan")
          : plan.id === "free"
            ? t("Start for free")
            : needsVerification
              ? t("Verify & choose plan")
              : t("Choose {{name}}", { name: plan.name })}
      </Button>

      <ul className="mt-7 flex flex-1 flex-col gap-3">
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
