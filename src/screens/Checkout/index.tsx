import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, CircleNotch, Lock, WarningCircle } from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";
import { PLANS, CREDIT_PACKS, PAYMENT_METHODS } from "../../lib/mockData";
import { formatVND } from "../../lib/format";
import { useAppStore } from "../../lib/store";
import { cn } from "../../lib/cn";
import type { PaymentMethod } from "../../lib/types";

type Status = "idle" | "processing" | "declined";

export default function CheckoutPage() {
  const navigate = useNavigate();
  const item = useAppStore((s) => s.pendingCheckoutItem);
  const completePurchase = useAppStore((s) => s.completePurchase);
  const [method, setMethod] = useState<PaymentMethod>("vnpay");
  const [status, setStatus] = useState<Status>("idle");

  useEffect(() => {
    if (!item) navigate("/pricing", { replace: true });
  }, [item, navigate]);

  if (!item) return null;

  const plan = item.kind === "plan" ? PLANS.find((p) => p.id === item.plan) : null;
  const pack = item.kind === "pack" ? CREDIT_PACKS.find((p) => p.id === item.packId) : null;
  const price = plan
    ? item.kind === "plan" && item.billingCycle === "annual"
      ? plan.priceAnnual
      : plan.priceMonthly
    : (pack?.price ?? 0);
  const selectedMethod = PAYMENT_METHODS.find((m) => m.id === method);

  function confirmPay(shouldDecline: boolean) {
    setStatus("processing");
    setTimeout(() => {
      if (shouldDecline) {
        setStatus("declined");
      } else {
        completePurchase();
        navigate("/payment-success");
      }
    }, 1600);
  }

  return (
    <div className="mx-auto max-w-2xl px-5 py-14 sm:px-8">
      <h1 className="text-h2 font-bold tracking-tight text-navy-900">Checkout</h1>
      <p className="mt-1.5 text-sm text-ink-500">Mock payment for demo purposes. No real charge occurs.</p>

      <div className="mt-7 rounded-[var(--radius-card-lg)] border border-line bg-white p-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Order summary</p>
        <div className="mt-3 flex items-center justify-between border-b border-line pb-4">
          <div>
            <p className="text-sm font-bold text-navy-900">
              {plan ? plan.name : `${pack?.label} pack`}
            </p>
            <p className="text-xs text-ink-500">
              {plan
                ? `Billed ${item.kind === "plan" && item.billingCycle === "annual" ? "annually" : "monthly"}`
                : "One-time purchase, credits never expire"}
            </p>
          </div>
          <p className="text-sm font-bold text-ink-900">{formatVND(price)}</p>
        </div>
        <div className="flex items-center justify-between pt-4">
          <p className="text-sm font-bold text-navy-900">Total</p>
          <p className="text-lg font-extrabold text-navy-900">{formatVND(price)}</p>
        </div>
      </div>

      <div className="mt-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Payment method</p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {PAYMENT_METHODS.map((m) => (
            <button
              key={m.id}
              onClick={() => setMethod(m.id)}
              className={cn(
                "flex items-center gap-3 rounded-[var(--radius-card)] border-2 p-4 text-left transition-colors",
                method === m.id ? "border-brand-500 bg-brand-100/30" : "border-line hover:border-brand-300",
              )}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white ring-1 ring-line">
                <img src={m.logo} alt={m.label} className="size-7 object-contain" />
              </span>
              <span className="text-sm font-semibold text-ink-900">{m.label}</span>
              {method === m.id && <Check size={16} weight="bold" className="ml-auto text-brand-600" />}
            </button>
          ))}
        </div>

        {selectedMethod?.hasQr && (
          <div className="mt-4 rounded-[var(--radius-card)] border border-line bg-slate-50 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-navy-900">Demo VietQR</p>
                <p className="text-xs text-ink-500">Scan this preview to continue the mock payment flow.</p>
              </div>
              <span className="rounded-full bg-brand-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-brand-700">
                Scan to pay
              </span>
            </div>

            <div className="mt-3 flex justify-center rounded-2xl border border-dashed border-line bg-white p-4">
              <img
                src={`https://api.vietqr.io/image/970423-00004634438-ajMAt1a.jpg?accountName=NGUYEN%20BA%20TUNG%20DUONG&amount=${price}`}
                alt="VietQR code"
                className="h-[220px] w-[220px] rounded-xl object-contain"
              />
            </div>
          </div>
        )}
      </div>

      {status === "declined" && (
        <div className="mt-6 flex items-start gap-3 rounded-[var(--radius-card)] border border-severity-high-line bg-severity-high-bg px-4 py-3.5 text-sm text-severity-high">
          <WarningCircle size={20} weight="fill" className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Payment declined</p>
            <p className="mt-0.5 text-severity-high/90">
              {PAYMENT_METHODS.find((m) => m.id === method)?.label} declined this transaction. Try again or
              use a different payment method.
            </p>
          </div>
        </div>
      )}

      <div className="mt-7 flex flex-col gap-3">
        <Button
          size="lg"
          loading={status === "processing"}
          onClick={() => confirmPay(false)}
          iconLeft={<Lock size={16} weight="fill" />}
          fullWidth
        >
          {status === "processing" ? "Processing payment..." : `Confirm & Pay ${formatVND(price)}`}
        </Button>

        {status === "declined" ? (
          <Button variant="outline" fullWidth onClick={() => setStatus("idle")}>
            Try again
          </Button>
        ) : (
          <button
            onClick={() => confirmPay(true)}
            disabled={status === "processing"}
            className="mx-auto flex items-center gap-1.5 text-xs text-ink-400 hover:text-ink-600 disabled:opacity-40"
          >
            {status === "processing" && <CircleNotch size={12} className="animate-spin" />}
            Simulate a declined payment (demo)
          </button>
        )}
      </div>
    </div>
  );
}
