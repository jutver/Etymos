import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CaretDown, Check, Minus } from "@phosphor-icons/react";
import { PlanCard } from "../../components/PlanCard";
import { Button } from "../../components/ui/Button";
import { FEATURE_MATRIX } from "../../lib/mockData";
import { fetchPlanDefinitions, fetchCreditPacks, fetchActivePlanDiscounts } from "../../lib/configQueries";
import type { ActivePlanDiscount } from "../../lib/configQueries";
import { annualSavingsPercent, formatVND } from "@etymos/shared";
import { useAppStore } from "../../lib/store";
import { cn } from "@etymos/shared";
import type { BillingCycle, CreditPack, PlanDefinition } from "@etymos/shared";

function applyDiscount(price: number, discount: ActivePlanDiscount): number {
  return discount.discount_type === "percent"
    ? price * (1 - discount.amount / 100)
    : Math.max(0, price - discount.amount);
}

const faqs = [
  {
    q: "Can I cancel my subscription anytime?",
    a: "Yes. Cancel anytime from your account settings, no questions asked. You'll keep Premium access until the end of your current billing period.",
  },
  {
    q: "What happens to my history if I downgrade to Free?",
    a: "Your existing reports stay accessible for 7 days, matching the Free plan's retention window. Upgrade again anytime to restore extended history retention (9 months on Standard, 12 months on Premium).",
  },
  {
    q: "Is paying with VNPay, MoMo, or ZaloPay secure?",
    a: "Yes. All three are established Vietnamese payment processors. Etymos never stores your card or wallet credentials directly.",
  },
  {
    q: "What's the difference between subscribing and buying credits?",
    a: "A subscription gives unlimited checks for a flat monthly fee, best for regular use. Credit packs are pay-per-use, best if you only need to check a document occasionally.",
  },
  {
    q: "Do you support languages other than Vietnamese?",
    a: "Yes. Etymos is Vietnamese-first but also supports English, French, and Japanese documents on Standard and Premium.",
  },
];

export default function PricingPage() {
  const navigate = useNavigate();
  const [billingCycle, setBillingCycle] = useState<BillingCycle>("monthly");
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const selectCheckoutItem = useAppStore((s) => s.selectCheckoutItem);

  const [plans, setPlans] = useState<PlanDefinition[]>([]);
  const [creditPacks, setCreditPacks] = useState<CreditPack[]>([]);
  const [discounts, setDiscounts] = useState<ActivePlanDiscount[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchPlanDefinitions(), fetchCreditPacks(), fetchActivePlanDiscounts()])
      .then(([planRows, packRows, discountRows]) => {
        if (cancelled) return;
        setPlans(planRows);
        setCreditPacks(packRows);
        setDiscounts(discountRows);
      })
      .catch((err: unknown) => console.error("Failed to load pricing config", err));
    return () => {
      cancelled = true;
    };
  }, []);

  const maxAnnualSavings = Math.max(
    0,
    ...plans.filter((p) => p.id !== "free").map((p) => annualSavingsPercent(p.priceMonthly, p.priceAnnual)),
  );

  function buyPack(packId: CreditPack["id"]) {
    selectCheckoutItem({ kind: "pack", packId });
    navigate("/checkout");
  }

  return (
    <div>
      <section className="mx-auto max-w-4xl px-5 pb-4 pt-16 text-center sm:px-8">
        <h1 className="text-h1 font-bold tracking-tight text-navy-900">
          Simple, honest pricing
        </h1>
        <p className="mx-auto mt-3 max-w-md text-body-lg text-ink-600">
          Start free. Upgrade when you need unlimited checks, semantic detection, and AI Rewrite.
        </p>

        <div className="mx-auto mt-7 inline-flex items-center gap-1 rounded-full bg-surface-muted p-1">
          <button
            onClick={() => setBillingCycle("monthly")}
            className={cn(
              "rounded-full px-5 py-2 text-sm font-semibold transition-colors",
              billingCycle === "monthly" ? "bg-white text-navy-900 shadow-sm" : "text-ink-500",
            )}
          >
            Monthly
          </button>
          <button
            onClick={() => setBillingCycle("annual")}
            className={cn(
              "flex items-center gap-2 rounded-full px-5 py-2 text-sm font-semibold transition-colors",
              billingCycle === "annual" ? "bg-white text-navy-900 shadow-sm" : "text-ink-500",
            )}
          >
            Annual
            <span className="rounded-full bg-success-bg px-2 py-0.5 text-[0.6875rem] font-bold text-success">
              Save up to {maxAnnualSavings}%
            </span>
          </button>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-14 sm:px-8">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-5">
          {plans.map((plan) => {
            const discount = discounts.find((d) => d.target_type === "plan" && d.target_id === plan.id);
            const basePrice = billingCycle === "monthly" ? plan.priceMonthly : plan.priceAnnual;
            const discountedPrice = discount ? applyDiscount(basePrice, discount) : undefined;
            return (
              <PlanCard key={plan.id} plan={plan} billingCycle={billingCycle} discountedPrice={discountedPrice} />
            );
          })}
        </div>
      </section>

      {/* Credit packs */}
      <section className="bg-surface-tint py-16">
        <div className="mx-auto max-w-6xl px-5 sm:px-8">
          <div className="text-center">
            <h2 className="text-h2 font-bold tracking-tight text-navy-900">
              Prefer to pay as you go?
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-ink-600">
              Buy credits for one-off checks, no subscription required. Credits never expire.
            </p>
          </div>

          <div className="mx-auto mt-9 grid max-w-xl grid-cols-1 gap-5 sm:grid-cols-2">
            {creditPacks.map((pack) => {
              const discount = discounts.find((d) => d.target_type === "pack" && d.target_id === pack.id);
              const discountedPrice = discount ? applyDiscount(pack.price, discount) : undefined;
              const hasDiscount = discountedPrice !== undefined && discountedPrice < pack.price;
              return (
                <div
                  key={pack.id}
                  className="relative flex flex-col items-center rounded-[var(--radius-card-lg)] border border-line bg-white p-7 text-center"
                >
                  {pack.badge && (
                    <span className="absolute -top-3 rounded-full brand-gradient px-3 py-1 text-[0.6875rem] font-bold text-white">
                      {pack.badge}
                    </span>
                  )}
                  <p className="text-lg font-bold text-navy-900">{pack.label}</p>
                  <div className="mt-3 flex items-baseline justify-center gap-1.5">
                    {hasDiscount && (
                      <span className="text-base font-semibold text-ink-400 line-through">
                        {formatVND(pack.price)}
                      </span>
                    )}
                    <span className={cn("text-3xl font-extrabold", hasDiscount ? "text-success" : "text-navy-900")}>
                      {formatVND(hasDiscount ? discountedPrice : pack.price)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-ink-500">{pack.description}</p>
                  <Button variant="secondary" fullWidth className="mt-5" onClick={() => buyPack(pack.id)}>
                    Buy credits
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Feature comparison table */}
      <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8">
        <h2 className="text-center text-h2 font-bold tracking-tight text-navy-900">
          Compare every feature
        </h2>

        <div className="mt-9 overflow-x-auto rounded-[var(--radius-card-lg)] border border-line">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-tint text-left">
                <th className="px-5 py-4 font-semibold text-ink-500">Feature</th>
                <th className="px-5 py-4 text-center font-semibold text-ink-700">Free</th>
                <th className="px-5 py-4 text-center font-semibold text-brand-600">
                  Standard
                </th>
                <th className="px-5 py-4 text-center font-semibold text-ink-700">Premium</th>
              </tr>
            </thead>
            <tbody>
              {FEATURE_MATRIX.map((row, i) => (
                <tr key={row.feature} className={cn(i % 2 === 1 && "bg-surface-tint/50")}>
                  <td className="px-5 py-3.5 font-medium text-ink-800">{row.feature}</td>
                  <td className="px-5 py-3.5 text-center">
                    <Cell value={row.free} />
                  </td>
                  <td className="px-5 py-3.5 text-center">
                    <Cell value={row.student} />
                  </td>
                  <td className="px-5 py-3.5 text-center">
                    <Cell value={row.professional} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* FAQ */}
      <section className="mx-auto max-w-2xl px-5 py-20 sm:px-8">
        <h2 className="text-center text-h2 font-bold tracking-tight text-navy-900">
          Frequently asked questions
        </h2>
        <div className="mt-8 flex flex-col gap-2">
          {faqs.map((f, i) => (
            <div key={f.q} className="rounded-[var(--radius-card)] border border-line bg-white">
              <button
                onClick={() => setOpenFaq(openFaq === i ? null : i)}
                className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
              >
                <span className="text-sm font-semibold text-ink-900">{f.q}</span>
                <CaretDown
                  size={16}
                  className={cn("shrink-0 text-ink-400 transition-transform", openFaq === i && "rotate-180")}
                />
              </button>
              {openFaq === i && (
                <p className="px-5 pb-4 text-sm leading-relaxed text-ink-600">{f.a}</p>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Cell({ value }: { value: boolean | string }) {
  if (typeof value === "string") {
    return <span className="text-xs font-medium text-ink-700">{value}</span>;
  }
  return value ? (
    <Check size={17} weight="bold" className="mx-auto text-success" />
  ) : (
    <Minus size={15} className="mx-auto text-ink-300" />
  );
}
