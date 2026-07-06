import { Check, Star } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type { BillingCycle, PlanDefinition } from "../lib/types";
import { formatVND } from "../lib/format";
import { useAppStore } from "../lib/store";
import { Button } from "./ui/Button";
import { cn } from "../lib/cn";

export function PlanCard({
  plan,
  billingCycle,
}: {
  plan: PlanDefinition;
  billingCycle: BillingCycle;
}) {
  const navigate = useNavigate();
  const currentPlan = useAppStore((s) => s.plan);
  const selectCheckoutItem = useAppStore((s) => s.selectCheckoutItem);
  const isCurrent = currentPlan === plan.id;
  const price = billingCycle === "monthly" ? plan.priceMonthly : plan.priceAnnual;

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
    navigate("/checkout");
  }

  return (
    <div
      className={cn(
        "relative flex flex-col rounded-[var(--radius-card-lg)] border bg-white p-7",
        plan.mostPopular
          ? "border-brand-500 shadow-[0_20px_48px_-16px_rgba(30,79,196,0.35)] lg:-translate-y-3"
          : "border-line shadow-[var(--shadow-card)]",
      )}
    >
      {plan.mostPopular && (
        <span className="absolute -top-3.5 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full brand-gradient px-3.5 py-1.5 text-xs font-bold text-white shadow-[0_6px_16px_-4px_rgba(30,79,196,0.5)]">
          <Star size={12} weight="fill" />
          Most popular
        </span>
      )}

      <h3 className="text-h3 font-bold text-navy-900">{plan.name}</h3>
      <p className="mt-1.5 text-sm text-ink-500">{plan.tagline}</p>

      <div className="mt-6 flex items-baseline gap-1.5">
        <span className="text-3xl font-extrabold tracking-tight text-navy-900">
          {price === 0 ? "0 đ" : formatVND(price)}
        </span>
        {price > 0 && (
          <span className="text-sm font-medium text-ink-500">
            /{billingCycle === "monthly" ? "mo" : "yr"}
          </span>
        )}
      </div>
      {plan.id !== "free" && billingCycle === "annual" && (
        <p className="mt-1 text-xs font-medium text-success">2 months free vs. monthly</p>
      )}

      <Button
        onClick={handleSelect}
        variant={plan.mostPopular ? "primary" : isCurrent ? "outline" : "secondary"}
        fullWidth
        className="mt-6"
        disabled={isCurrent}
      >
        {isCurrent ? "Current plan" : plan.id === "free" ? "Start for free" : `Choose ${plan.name}`}
      </Button>

      <ul className="mt-7 flex flex-1 flex-col gap-3">
        {plan.features.map((f) => (
          <li key={f} className="flex items-start gap-2.5 text-sm text-ink-700">
            <Check size={16} weight="bold" className="mt-0.5 shrink-0 text-brand-500" />
            <span>{f}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
