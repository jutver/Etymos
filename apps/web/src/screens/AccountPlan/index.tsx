import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowClockwise,
  ArrowRight,
  CalendarBlank,
  GraduationCap,
  QrCode,
  Receipt,
  ShieldCheck,
  WarningCircle,
} from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";
import { PillIndicator, usePill } from "../../components/ui/PillIndicator";
import { UsageMeter } from "../../components/UsageMeter";
import { PlanCard } from "../../components/PlanCard";
import { fetchPlanDefinitions, fetchCreditPacks } from "../../lib/configQueries";
import { formatVND } from "@etymos/shared";
import { planLabel, planDocLimit, useAppStore } from "../../lib/store";
import { cn } from "@etymos/shared";
import { describeOrder, orderCheckoutItem, subscriptionStatus, timeLeft } from "../../lib/payments";
import { getActivePaymentOrder, type PaymentOrder } from "../../lib/api";
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
  const cyclePill = usePill<HTMLDivElement>(billingCycle);
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

      <PendingOrderNotice />

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
          <div ref={cyclePill.ref} className="relative grid grid-cols-2 gap-1 self-start rounded-full bg-surface-muted p-1">
            <PillIndicator box={cyclePill.box} className="bg-white shadow-sm" />
            {(["monthly", "annual"] as const).map((cycle) => (
              <button
                key={cycle}
                type="button"
                aria-pressed={billingCycle === cycle}
                data-pill-active={billingCycle === cycle}
                onClick={() => setBillingCycle(cycle)}
                className={cn(
                  "relative rounded-full px-6 py-2 text-sm font-semibold transition-colors",
                  billingCycle === cycle ? "text-navy-900" : "text-ink-500 hover:text-ink-700",
                )}
              >
                <span className="relative">{cycle === "monthly" ? t("Monthly") : t("Annual")}</span>
              </button>
            ))}
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

/**
 * An order the user started on "Scan to pay" but hasn't paid yet (they closed
 * the tab, say). /api/payments/orders/active only returns unpaid, unexpired
 * orders; "Continue payment" re-selects the same item, and /checkout's resume
 * check then reopens that order's QR instead of issuing a new one.
 */
function PendingOrderNotice() {
  const navigate = useNavigate();
  const selectCheckoutItem = useAppStore((s) => s.selectCheckoutItem);
  const [order, setOrder] = useState<PaymentOrder | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    getActivePaymentOrder()
      .then((active) => {
        if (!cancelled) setOrder(active);
      })
      .catch((err: unknown) => console.warn("Couldn't load the pending order", err));
    return () => {
      cancelled = true;
    };
  }, []);

  const expiresAt = order?.expires_at ?? null;
  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  const item = order ? orderCheckoutItem(order) : null;
  const remaining = order ? timeLeft(order.expires_at, now) : null;
  if (!order || !item || (order.expires_at !== null && remaining === null)) return null;

  function continuePayment() {
    if (!item) return;
    selectCheckoutItem(item);
    navigate("/checkout");
  }

  return (
    <section
      aria-live="polite"
      className="mt-8 flex flex-col gap-4 rounded-[var(--radius-card-lg)] border border-severity-moderate-line bg-severity-moderate-bg p-5 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-3">
        <QrCode size={22} weight="bold" className="mt-0.5 shrink-0 text-severity-moderate" />
        <div>
          <p className="text-sm font-bold text-ink-900">{t("You have an order awaiting payment")}</p>
          <p className="mt-0.5 text-sm text-ink-700">
            {describeOrder(order)} · {formatVND(order.amount)}
          </p>
          {remaining && (
            <p className="mt-0.5 font-mono text-xs text-ink-500">{t("QR valid for {{time}}", { time: remaining })}</p>
          )}
        </div>
      </div>
      <Button size="sm" onClick={continuePayment} iconRight={<ArrowRight size={15} weight="bold" />} className="shrink-0 self-start sm:self-auto">
        {t("Continue payment")}
      </Button>
    </section>
  );
}
