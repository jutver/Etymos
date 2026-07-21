import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, HourglassMedium, PaperPlaneTilt, Tag, WarningCircle } from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";
import { PAYMENT_METHODS } from "../../lib/mockData";
import { fetchPlanDefinitions, fetchCreditPacks, fetchActivePlanDiscounts } from "../../lib/configQueries";
import { formatVND, supabase } from "@etymos/shared";
import { useAppStore } from "../../lib/store";
import { useAuth } from "../../lib/auth";
import { createPurchaseRequest, describePurchaseRequest, useMyPendingRequest } from "../../lib/purchaseRequests";
import { cn } from "@etymos/shared";
import type { CreditPack, PaymentMethod, PlanDefinition } from "@etymos/shared";

type Status = "idle" | "submitting" | "error";

interface AppliedDiscount {
  discount_type: "percent" | "fixed";
  amount: number;
  source: "auto" | "code";
}

function applyDiscount(price: number, discount: AppliedDiscount): number {
  return discount.discount_type === "percent"
    ? price * (1 - discount.amount / 100)
    : Math.max(0, price - discount.amount);
}

type CodeStatus = "idle" | "applying" | "error";

export default function CheckoutPage() {
  const navigate = useNavigate();
  const item = useAppStore((s) => s.pendingCheckoutItem);
  const { user } = useAuth();
  const { pending, loading: pendingLoading, refresh: refreshPending } = useMyPendingRequest();
  const [method, setMethod] = useState<PaymentMethod>("vnpay");
  const [status, setStatus] = useState<Status>("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [plans, setPlans] = useState<PlanDefinition[]>([]);
  const [creditPacks, setCreditPacks] = useState<CreditPack[]>([]);
  const [configLoading, setConfigLoading] = useState(true);

  const [appliedDiscount, setAppliedDiscount] = useState<AppliedDiscount | null>(null);
  const [codeInput, setCodeInput] = useState("");
  const [codeStatus, setCodeStatus] = useState<CodeStatus>("idle");
  const [codeError, setCodeError] = useState<string | null>(null);

  useEffect(() => {
    if (!item) navigate("/pricing", { replace: true });
  }, [item, navigate]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchPlanDefinitions(), fetchCreditPacks(), fetchActivePlanDiscounts()])
      .then(([planRows, packRows, discountRows]) => {
        if (cancelled) return;
        setPlans(planRows);
        setCreditPacks(packRows);

        if (!item) return;
        const targetType = item.kind === "plan" ? "plan" : "pack";
        const targetId = item.kind === "plan" ? item.plan : item.packId;
        const match = discountRows.find((d) => d.target_type === targetType && d.target_id === targetId);
        if (match) {
          setAppliedDiscount({ discount_type: match.discount_type, amount: match.amount, source: "auto" });
        }
      })
      .catch((err: unknown) => console.error("Failed to load pricing config", err))
      .finally(() => {
        if (!cancelled) setConfigLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!item) return null;
  if (configLoading || pendingLoading) {
    return <div className="mx-auto max-w-2xl px-5 py-14 text-center text-sm text-ink-500 sm:px-8">Loading…</div>;
  }

  // One outstanding request at a time. Only an admin can clear it, so there is
  // nothing useful the user can do here until it is reviewed.
  if (pending) {
    return (
      <div className="mx-auto max-w-2xl px-5 py-14 sm:px-8">
        <h1 className="text-h2 font-bold tracking-tight text-navy-900">Request awaiting approval</h1>
        <div className="mt-7 flex items-start gap-3 rounded-[var(--radius-card-lg)] border border-line bg-white p-6">
          <HourglassMedium size={22} weight="fill" className="mt-0.5 shrink-0 text-brand-600" />
          <div>
            <p className="text-sm font-semibold text-navy-900">
              You already have a request for {describePurchaseRequest(pending)}.
            </p>
            <p className="mt-1 text-sm text-ink-500">
              An admin reviews it manually. You'll be able to make another request once this one has been
              approved or declined.
            </p>
          </div>
        </div>
        <div className="mt-7 flex flex-col gap-3">
          <Button as="link" to="/account/plan" size="lg" fullWidth>
            Back to My Plan
          </Button>
        </div>
      </div>
    );
  }

  const plan = item.kind === "plan" ? plans.find((p) => p.id === item.plan) : null;
  const pack = item.kind === "pack" ? creditPacks.find((p) => p.id === item.packId) : null;
  const basePrice = plan
    ? item.kind === "plan" && item.billingCycle === "annual"
      ? plan.priceAnnual
      : plan.priceMonthly
    : (pack?.price ?? 0);
  const price = appliedDiscount ? applyDiscount(basePrice, appliedDiscount) : basePrice;
  const hasDiscount = price < basePrice;
  const selectedMethod = PAYMENT_METHODS.find((m) => m.id === method);

  async function applyCode() {
    const code = codeInput.trim();
    if (!code) return;
    setCodeStatus("applying");
    setCodeError(null);
    const { data, error } = await supabase.rpc("redeem_discount_code", { p_code: code });
    if (error) {
      setCodeStatus("error");
      setCodeError(error.message);
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      setCodeStatus("error");
      setCodeError("Invalid discount code.");
      return;
    }
    // A manually-applied code overrides any automatic plan/pack discount
    // rather than stacking with it — simpler and less confusing to the user.
    setAppliedDiscount({ discount_type: row.discount_type, amount: row.amount, source: "code" });
    setCodeStatus("idle");
  }

  // Submitting does NOT change the user's plan or credit balances — it only
  // files a pending checkout_events row for an admin to approve. Access is
  // granted admin-side; this screen never writes to `profiles`.
  async function submitRequest() {
    if (!item || !user) return;
    setStatus("submitting");
    setSubmitError(null);
    try {
      await createPurchaseRequest({ userId: user.id, item, amount: price, paymentMethod: method });
      refreshPending();
      navigate("/payment-success");
    } catch (err: unknown) {
      setStatus("error");
      setSubmitError(err instanceof Error ? err.message : "Could not submit your request. Please try again.");
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-5 py-14 sm:px-8">
      <h1 className="text-h2 font-bold tracking-tight text-navy-900">Request access</h1>
      <p className="mt-1.5 text-sm text-ink-500">
        Transfer the amount below, then submit your request. An admin confirms the payment manually before
        your plan or credits are applied.
      </p>

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
          <div className="flex items-baseline gap-1.5">
            {hasDiscount && (
              <span className="text-xs font-semibold text-ink-400 line-through">{formatVND(basePrice)}</span>
            )}
            <p className={cn("text-sm font-bold", hasDiscount ? "text-success" : "text-ink-900")}>
              {formatVND(price)}
            </p>
          </div>
        </div>

        <div className="border-b border-line pb-4">
          <div className="flex items-center gap-2">
            <Tag size={14} className="shrink-0 text-ink-400" />
            <input
              value={codeInput}
              onChange={(e) => {
                setCodeInput(e.target.value);
                setCodeStatus("idle");
                setCodeError(null);
              }}
              placeholder="Discount code"
              className="min-w-0 flex-1 rounded-full border border-line bg-surface-tint px-3.5 py-1.5 text-xs placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
            <button
              type="button"
              onClick={() => void applyCode()}
              disabled={!codeInput.trim() || codeStatus === "applying"}
              className="shrink-0 rounded-full border border-line px-3.5 py-1.5 text-xs font-semibold text-ink-700 hover:border-brand-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {codeStatus === "applying" ? "Applying…" : "Apply"}
            </button>
          </div>
          {codeError && <p className="mt-2 text-xs font-medium text-severity-high">{codeError}</p>}
          {appliedDiscount?.source === "code" && !codeError && (
            <p className="mt-2 text-xs font-medium text-success">Discount code applied.</p>
          )}
        </div>

        <div className="flex items-center justify-between pt-4">
          <p className="text-sm font-bold text-navy-900">Total</p>
          <div className="flex items-baseline gap-1.5">
            {hasDiscount && (
              <span className="text-sm font-semibold text-ink-400 line-through">{formatVND(basePrice)}</span>
            )}
            <p className={cn("text-lg font-extrabold", hasDiscount ? "text-success" : "text-navy-900")}>
              {formatVND(price)}
            </p>
          </div>
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
                <p className="text-sm font-semibold text-navy-900">VietQR transfer</p>
                <p className="text-xs text-ink-500">
                  Scan to transfer, then submit your request below for an admin to confirm.
                </p>
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

      {status === "error" && (
        <div className="mt-6 flex items-start gap-3 rounded-[var(--radius-card)] border border-severity-high-line bg-severity-high-bg px-4 py-3.5 text-sm text-severity-high">
          <WarningCircle size={20} weight="fill" className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Couldn't submit your request</p>
            <p className="mt-0.5 text-severity-high/90">{submitError}</p>
          </div>
        </div>
      )}

      <div className="mt-7 flex flex-col gap-3">
        <Button
          size="lg"
          loading={status === "submitting"}
          onClick={() => void submitRequest()}
          iconLeft={<PaperPlaneTilt size={16} weight="fill" />}
          fullWidth
        >
          {status === "submitting"
            ? "Submitting request..."
            : `Submit request for ${formatVND(price)}`}
        </Button>
        <p className="text-center text-xs text-ink-400">
          Nothing is charged automatically and no access is granted until an admin approves your request.
        </p>
      </div>
    </div>
  );
}
