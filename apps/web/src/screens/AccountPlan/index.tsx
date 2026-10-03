import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowClockwise,
  CalendarBlank,
  GraduationCap,
  Receipt,
  ShieldCheck,
  WarningCircle,
} from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";
import { UsageMeter } from "../../components/UsageMeter";
import { PlanCard } from "../../components/PlanCard";
import { fetchPlanDefinitions, fetchCreditPacks } from "../../lib/configQueries";
import { annualSavingsPercent, formatVND } from "@etymos/shared";
import { planLabel, planDocLimit, useAppStore } from "../../lib/store";
import { cn } from "@etymos/shared";
import { subscriptionStatus } from "../../lib/payments";
import type { BillingCycle, CreditPack, PlanDefinition } from "@etymos/shared";
import { t, tn, currentLocale } from "../../lib/i18n";

export default function AccountPlanPage() {
  const navigate = useNavigate();
  const plan = useAppStore((s) => s.plan);
  const standardCredits = useAppStore((s) => s.standardCredits);
  const premiumCredits = useAppStore((s) => s.premiumCredits);
  const checksUsedThisPeriod = useAppStore((s) => s.checksUsedThisPeriod);
  const studentVerified = useAppStore((s) => s.studentVerified);
  const planResetInfo = useAppStore((s) => s.planResetInfo);
  const rolloverPlanPeriodIfNeeded = useAppStore((s) => s.rolloverPlanPeriodIfNeeded);
  const selectCheckoutItem = useAppStore((s) => s.selectCheckoutItem);
  const planExpiresAt = useAppStore((s) => s.planExpiresAt);
  const currentCycle = useAppStore((s) => s.billingCycle);

  useEffect(() => {
    rolloverPlanPeriodIfNeeded();
  }, [rolloverPlanPeriodIfNeeded]);

  const { daysLeft, resetDate } = planResetInfo();
  const status = subscriptionStatus(plan, planExpiresAt);
  const [billingCycle, setBillingCycle] = useState<BillingCycle>("monthly");
  const [plans, setPlans] = useState<PlanDefinition[]>([]);
  const [creditPacks, setCreditPacks] = useState<CreditPack[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchPlanDefinitions(), fetchCreditPacks()])
      .then(([planRows, packRows]) => {
        if (cancelled) return;
        setPlans(planRows);
        setCreditPacks(packRows);
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

  function renew() {
    if (plan === "free") return;
    selectCheckoutItem({ kind: "plan", plan, billingCycle: currentCycle });
    navigate("/checkout");
  }

  const formatDay = (iso: string) => new Date(iso).toLocaleDateString(currentLocale(), { dateStyle: "long" });

  function buyPack(packId: CreditPack["id"]) {
    selectCheckoutItem({ kind: "pack", packId });
    navigate("/checkout");
  }

  return (
    <div className="studio-page collection-editorial mx-auto max-w-5xl px-5 py-10 sm:px-8">
      <p aria-hidden="true" className="editorial-kicker mb-3">{t("YOUR MEMBERSHIP")}</p><h1 className="text-h1 font-bold tracking-tight text-navy-900">{t("My Plan")}</h1>
      <p className="mt-1.5 text-sm text-ink-500">{t("Usage, billing, and subscription in one place.")}</p>


      <section className="studio-card mt-8 rounded-[var(--radius-card-lg)] border border-line bg-white p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">{t("Current plan")}</p>
            <p className="flex items-center gap-2 text-2xl font-extrabold text-navy-900">
              {t(planLabel(plan))}
              {plan === "student" && studentVerified && (
                <span className="flex items-center gap-1 rounded-full bg-success-bg px-2.5 py-1 text-xs font-bold text-success">
                  <GraduationCap size={13} weight="fill" />
                  {t("Verified")}</span>
              )}
            </p>
          </div>
          <UsageMeter interactive={false} />
        </div>

        <p className="mt-4 text-xs text-ink-500">
          {t("{{used}} of {{limit}} checks used this cycle.", { used: checksUsedThisPeriod, limit: planDocLimit(plan) })}</p>

        <div className="mt-4 flex items-center gap-2 rounded-[var(--radius-control)] border border-line bg-surface-tint px-4 py-2.5 text-sm text-ink-700">
          <CalendarBlank size={16} className="text-ink-400" />
          {tn(daysLeft, "Usage resets in {{count}} day", "Usage resets in {{count}} days")} ({resetDate.toLocaleDateString(currentLocale())})
        </div>
      </section>

      <section className="studio-card mt-6 rounded-[var(--radius-card-lg)] border border-line bg-white p-6">
        <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-ink-900">
          <ShieldCheck size={17} weight="bold" />
          {t("Subscription management")}</h2>

        {status.kind === "free" ? (
          <p className="mt-4 text-sm text-ink-500">
            {status.endedAt
              ? t("Your paid plan ended on {{date}}. Choose a plan below to subscribe again.", { date: formatDay(status.endedAt) })
              : t("You're on the Free plan. Choose a plan below to unlock more checks.")}
          </p>
        ) : (
          <>
            <div
              className={cn(
                "mt-4 flex flex-col gap-3 rounded-[var(--radius-control)] border px-4 py-3 sm:flex-row sm:items-center sm:justify-between",
                status.kind === "ending_soon" ? "border-severity-moderate-line bg-severity-moderate-bg" : "border-line",
              )}
            >
              <div>
                <p className="flex items-center gap-1.5 text-sm font-semibold text-ink-900">
                  {status.kind === "ending_soon" && <WarningCircle size={16} weight="fill" className="text-severity-moderate" />}
                  {status.kind === "no_end"
                    ? t("Active, no end date")
                    : t("Active until {{date}}", { date: formatDay(status.endsAt) })}
                </p>
                <p className="text-xs text-ink-500">
                  {currentCycle === "annual" ? t("Yearly plan") : t("Monthly plan")}
                  {status.kind !== "no_end" && (
                    <> · {tn(status.daysLeft, "{{count}} day left", "{{count}} days left")}</>
                  )}
                </p>
              </div>
              {status.kind !== "no_end" && (
                <Button size="sm" onClick={renew} iconLeft={<ArrowClockwise size={15} weight="bold" />}>
                  {t("Renew")}</Button>
              )}
            </div>
            <p className="mt-3 text-xs text-ink-500">
              {t("Plans are paid in advance by bank transfer, so nothing is ever charged automatically. Renewing adds another term to the end of your current one; if you don't renew, your account moves to the Free plan when the term ends.")}</p>
          </>
        )}

        <div className="mt-5 border-t border-line pt-4">
          <Button as="link" to="/account/payments" variant="outline" size="sm" iconLeft={<Receipt size={15} />}>
            {t("Payment history")}</Button>
        </div>
      </section>

      <section className="mt-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-h3 font-bold tracking-tight text-navy-900">{t("Change plan")}</h2>
          <div className="inline-flex items-center gap-1 self-start rounded-full bg-surface-muted p-1">
            <button
              onClick={() => setBillingCycle("monthly")}
              className={cn(
                "rounded-full px-5 py-2 text-sm font-semibold transition-colors",
                billingCycle === "monthly" ? "bg-white text-navy-900 shadow-sm" : "text-ink-500",
              )}
            >
              {t("Monthly")}</button>
            <button
              onClick={() => setBillingCycle("annual")}
              className={cn(
                "flex items-center gap-2 rounded-full px-5 py-2 text-sm font-semibold transition-colors",
                billingCycle === "annual" ? "bg-white text-navy-900 shadow-sm" : "text-ink-500",
              )}
            >
              {t("Annual")}<span className="rounded-full bg-success-bg px-2 py-0.5 text-[0.6875rem] font-bold text-success">
                {t("Save up to {{percent}}%", { percent: maxAnnualSavings })}
              </span>
            </button>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-5">
          {plans.map((p) => (
            <PlanCard key={p.id} plan={p} billingCycle={billingCycle} />
          ))}
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-h3 font-bold tracking-tight text-navy-900">{t("Buy credits")}</h2>
        <p className="mt-1 text-sm text-ink-500">{t("For one-off checks, no subscription required.")}</p>
        <div className="mx-auto mt-6 grid max-w-xl grid-cols-1 gap-5 sm:grid-cols-2">
          {creditPacks.map((pack) => (
            <div
              key={pack.id}
              className="studio-card relative flex flex-col items-center rounded-[var(--radius-card-lg)] border border-line bg-white p-7 text-center"
            >
              {pack.badge && (
                <span className="absolute -top-3 rounded-full brand-gradient px-3 py-1 text-[0.6875rem] font-bold text-white">
                  {t(pack.badge)}
                </span>
              )}
              <p className="text-lg font-bold text-navy-900">{t(pack.label)}</p>
              <p className="mt-3 text-3xl font-extrabold text-navy-900">{formatVND(pack.price)}</p>
              <p className="mt-1 text-xs text-ink-500">{t(pack.description)}</p>
              <Button
                variant="secondary"
                fullWidth
                className="mt-5"
                onClick={() => buyPack(pack.id)}
              >
                {t("Buy credits")}
              </Button>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-ink-400">
          {t("Current credit balance: {{standard}} standard, {{premium}} premium", { standard: standardCredits, premium: premiumCredits })}</p>
      </section>
    </div>
  );
}
