import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CalendarBlank,
  Check,
  CreditCard,
  GraduationCap,
  ShieldCheck,
  WarningCircle,
} from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";
import { UsageMeter } from "../../components/UsageMeter";
import { PlanCard } from "../../components/PlanCard";
import { PAYMENT_METHODS } from "../../lib/mockData";
import { fetchPlanDefinitions, fetchCreditPacks } from "../../lib/configQueries";
import { annualSavingsPercent, formatVND } from "@etymos/shared";
import { planLabel, planDocLimit, useAppStore } from "../../lib/store";
import { cn } from "@etymos/shared";
import type { BillingCycle, CreditPack, PaymentMethod, PlanDefinition } from "@etymos/shared";
import { t, tr, tn, currentLocale } from "../../lib/i18n";

export default function AccountPlanPage() {
  const navigate = useNavigate();
  const plan = useAppStore((s) => s.plan);
  const standardCredits = useAppStore((s) => s.standardCredits);
  const premiumCredits = useAppStore((s) => s.premiumCredits);
  const checksUsedThisPeriod = useAppStore((s) => s.checksUsedThisPeriod);
  const studentVerified = useAppStore((s) => s.studentVerified);
  const planResetInfo = useAppStore((s) => s.planResetInfo);
  const rolloverPlanPeriodIfNeeded = useAppStore((s) => s.rolloverPlanPeriodIfNeeded);
  const pushToast = useAppStore((s) => s.pushToast);
  const selectCheckoutItem = useAppStore((s) => s.selectCheckoutItem);
  const cancelSubscriptionAction = useAppStore((s) => s.cancelSubscription);

  useEffect(() => {
    rolloverPlanPeriodIfNeeded();
  }, [rolloverPlanPeriodIfNeeded]);

  const { daysLeft, resetDate } = planResetInfo();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [method, setMethod] = useState<PaymentMethod>("vnpay");
  const [methodOpen, setMethodOpen] = useState(false);
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

  function cancelSubscription() {
    cancelSubscriptionAction();
    setConfirmCancel(false);
    pushToast({ kind: "info", title: tr("Subscription canceled"), description: tr("You're back on the Free plan.") });
  }

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

        <div className="mt-4 flex items-center justify-between rounded-[var(--radius-control)] border border-line px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-ink-900">{t("Payment method")}</p>
            <p className="text-xs text-ink-500">
              {t(PAYMENT_METHODS.find((m) => m.id === method)?.label)}{" "}{t("on file (demo)")}</p>
          </div>
          <Button variant="outline" size="sm" iconLeft={<CreditCard size={15} />} onClick={() => setMethodOpen((v) => !v)}>
            {t("Manage")}</Button>
        </div>

        {methodOpen && (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {PAYMENT_METHODS.map((m) => (
              <button
                key={m.id}
                onClick={() => setMethod(m.id)}
                className={cn(
                  "flex items-center gap-3 rounded-[var(--radius-card)] border-2 p-3.5 text-left transition-colors",
                  method === m.id ? "border-brand-500 bg-brand-100/30" : "border-line hover:border-brand-300",
                )}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white ring-1 ring-line">
                  <img src={m.logo} alt={t(m.label)} className="size-6 object-contain" />
                </span>
                <span className="text-sm font-semibold text-ink-900">{t(m.label)}</span>
                {method === m.id && <Check size={15} weight="bold" className="ml-auto text-brand-600" />}
              </button>
            ))}
          </div>
        )}

        {plan !== "free" ? (
          <div className="mt-5">
            {confirmCancel ? (
              <div className="flex items-center gap-3 rounded-[var(--radius-control)] border border-severity-high-line bg-severity-high-bg px-4 py-3 text-sm text-severity-high">
                <WarningCircle size={18} weight="fill" className="shrink-0" />
                <span className="flex-1">{t("Cancel your subscription? You'll drop to the Free plan immediately.")}</span>
                <Button size="sm" variant="danger" onClick={cancelSubscription}>
                  {t("Confirm")}</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(false)}>
                  {t("Keep plan")}</Button>
              </div>
            ) : (
              <Button variant="outline" onClick={() => setConfirmCancel(true)}>
                {t("Cancel subscription")}</Button>
            )}
          </div>
        ) : (
          <p className="mt-5 text-sm text-ink-500">
            {t("You're on the Free plan. Choose a plan below to unlock unlimited checks.")}</p>
        )}
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
