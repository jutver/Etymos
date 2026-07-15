import { useNavigate } from "react-router-dom";
import { Check, Coins, ShieldWarning, Sparkle } from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";
import { PLANS, CREDIT_PACKS } from "../../lib/mockData";
import { formatVND } from "@etymos/shared";
import { useAppStore } from "../../lib/store";
import { cn } from "@etymos/shared";

export default function PaywallPage() {
  const navigate = useNavigate();
  const pendingDocLabel = useAppStore((s) => s.pendingDocLabel);
  const clearPendingCheck = useAppStore((s) => s.clearPendingCheck);
  const selectCheckoutItem = useAppStore((s) => s.selectCheckoutItem);

  const subscribePlans = PLANS.filter((p) => p.id !== "free");

  function choosePlan(plan: (typeof subscribePlans)[number]) {
    selectCheckoutItem({ kind: "plan", plan: plan.id as "student" | "professional", billingCycle: "monthly" });
    navigate("/checkout");
  }

  function choosePack(packId: (typeof CREDIT_PACKS)[number]["id"]) {
    selectCheckoutItem({ kind: "pack", packId });
    navigate("/checkout");
  }

  function maybeLater() {
    clearPendingCheck();
    navigate("/upload");
  }

  return (
    <div className="mx-auto max-w-4xl px-5 py-14 sm:px-8">
      <div className="text-center">
        <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-severity-moderate-bg text-severity-moderate">
          <ShieldWarning size={28} weight="fill" />
        </div>
        <h1 className="mt-5 text-h1 font-bold tracking-tight text-navy-900">
          You're out of checks for this month
        </h1>
        <p className="mx-auto mt-3 max-w-md text-body-lg text-ink-600">
          {pendingDocLabel
            ? <>We'll pick up right where you left off with <span className="font-semibold text-ink-800">{pendingDocLabel}</span> as soon as you're ready.</>
            : "Subscribe for unlimited checks, or buy credits for one-off use."}
        </p>
      </div>

      <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Subscribe */}
        <div className="rounded-[var(--radius-card-lg)] border border-line bg-white p-7">
          <p className="text-xs font-bold uppercase tracking-wide text-brand-600">Best value</p>
          <h2 className="mt-1.5 text-lg font-bold text-navy-900">Subscribe</h2>
          <p className="mt-1 text-sm text-ink-500">Unlimited checks for regular use.</p>

          <div className="mt-5 flex flex-col gap-3">
            {subscribePlans.map((plan) => (
              <div
                key={plan.id}
                className={cn(
                  "flex items-center justify-between gap-4 rounded-[var(--radius-card)] border p-4",
                  plan.mostPopular ? "border-brand-400 bg-brand-100/30" : "border-line",
                )}
              >
                <div>
                  <p className="flex items-center gap-1.5 text-sm font-bold text-navy-900">
                    {plan.name}
                    {plan.mostPopular && <Sparkle size={13} weight="fill" className="text-brand-500" />}
                  </p>
                  <p className="text-xs text-ink-500">{formatVND(plan.priceMonthly)}/mo</p>
                </div>
                <Button size="sm" variant={plan.mostPopular ? "primary" : "outline"} onClick={() => choosePlan(plan)}>
                  Choose
                </Button>
              </div>
            ))}
          </div>

          <ul className="mt-5 flex flex-col gap-2">
            {["More documents per month", "Higher word limits", "Priority support"].map((f) => (
              <li key={f} className="flex items-center gap-2 text-xs text-ink-600">
                <Check size={14} weight="bold" className="text-brand-500" />
                {f}
              </li>
            ))}
          </ul>
        </div>

        {/* Buy credits */}
        <div className="rounded-[var(--radius-card-lg)] border border-line bg-white p-7">
          <p className="text-xs font-bold uppercase tracking-wide text-ink-500">Pay as you go</p>
          <h2 className="mt-1.5 text-lg font-bold text-navy-900">Buy credits</h2>
          <p className="mt-1 text-sm text-ink-500">For one-off checks, no subscription.</p>

          <div className="mt-5 flex flex-col gap-3">
            {CREDIT_PACKS.map((pack) => (
              <div
                key={pack.id}
                className="flex items-center justify-between gap-4 rounded-[var(--radius-card)] border border-line p-4"
              >
                <div className="flex items-center gap-3">
                  <div className="flex size-9 items-center justify-center rounded-full bg-surface-muted text-ink-500">
                    <Coins size={17} weight="fill" />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-navy-900">{pack.label}</p>
                    <p className="text-xs text-ink-500">{formatVND(pack.price)} · {pack.description}</p>
                  </div>
                </div>
                <Button size="sm" variant="outline" onClick={() => choosePack(pack.id)}>
                  Buy
                </Button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-8 text-center">
        <button onClick={maybeLater} className="text-sm font-medium text-ink-500 hover:text-ink-700 hover:underline">
          Maybe later
        </button>
      </div>
    </div>
  );
}
