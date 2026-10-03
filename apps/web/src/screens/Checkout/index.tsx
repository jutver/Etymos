import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Bank,
  Check,
  CircleNotch,
  Copy,
  Lightning,
  Minus,
  Plus,
  Tag,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";
import { fetchPlanDefinitions, fetchCreditPacks } from "../../lib/configQueries";
import { formatVND } from "@etymos/shared";
import { useAppStore } from "../../lib/store";
import { useAuth } from "../../lib/auth";
import { fetchMyProfile } from "../../lib/profileQueries";
import {
  ApiError,
  cancelPaymentOrder,
  createPaymentOrder,
  getActivePaymentOrder,
  getPaymentOrder,
  quotePayment,
  type PaymentOrder,
  type PaymentQuote,
} from "../../lib/api";
import {
  describeOrder,
  isDiscountError,
  orderMatches,
  paymentErrorMessage as errorMessage,
  planPurchaseEffect,
  timeLeft,
  toPaymentItem,
} from "../../lib/payments";
import { cn } from "@etymos/shared";
import { trackEvent } from "../../lib/analytics";
import type { CreditPack, PlanDefinition } from "@etymos/shared";
import { t, currentLocale } from "../../lib/i18n";

const MIN_PACK_QUANTITY = 1;
const MAX_PACK_QUANTITY = 20;
/** How often the payment screen asks whether the transfer has arrived. */
const POLL_INTERVAL_MS = 4000;

export default function CheckoutPage() {
  const navigate = useNavigate();
  const item = useAppStore((s) => s.pendingCheckoutItem);
  const syncFromProfile = useAppStore((s) => s.syncFromProfile);
  const currentPlan = useAppStore((s) => s.plan);
  const currentPlanEnds = useAppStore((s) => s.planExpiresAt);
  const { user } = useAuth();
  const [plans, setPlans] = useState<PlanDefinition[]>([]);
  const [creditPacks, setCreditPacks] = useState<CreditPack[]>([]);
  const [configLoading, setConfigLoading] = useState(true);

  // Quantity only applies to pack purchases — a plan subscription has no
  // "how many" concept. Defaults to 1 and is clamped on every change.
  const [quantity, setQuantity] = useState(1);
  const [codeInput, setCodeInput] = useState("");
  const [appliedCode, setAppliedCode] = useState<string | null>(null);
  const [codeApplying, setCodeApplying] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [quote, setQuote] = useState<PaymentQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const [order, setOrder] = useState<PaymentOrder | null>(null);
  const [resuming, setResuming] = useState(true);
  const [creating, setCreating] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!item) navigate("/pricing", { replace: true });
  }, [item, navigate]);

  const hasItem = item !== null;
  useEffect(() => {
    if (hasItem) trackEvent("checkout_started");
  }, [hasItem]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchPlanDefinitions(), fetchCreditPacks()])
      .then(([planRows, packRows]) => {
        if (cancelled) return;
        setPlans(planRows);
        setCreditPacks(packRows);
      })
      .catch((err: unknown) => console.error("Failed to load pricing config", err))
      .finally(() => {
        if (!cancelled) setConfigLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Coming back to checkout (reload, another tab) resumes an unpaid order for
  // the same item instead of issuing a new QR.
  useEffect(() => {
    if (!item) return;
    let cancelled = false;
    getActivePaymentOrder()
      .then((active) => {
        if (cancelled || !active || !orderMatches(active, item)) return;
        setQuantity(active.quantity);
        setOrder(active);
      })
      .catch((err: unknown) => console.error("Failed to load the active order", err))
      .finally(() => {
        if (!cancelled) setResuming(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The price always comes from the backend, which is what the order will
  // charge. Re-quoted when the quantity or the applied code changes.
  useEffect(() => {
    if (!item || order) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      quotePayment(toPaymentItem(item, quantity), appliedCode ?? undefined)
        .then((q) => {
          if (cancelled) return;
          setQuote(q);
          setQuoteError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (isDiscountError(err)) {
            setAppliedCode(null);
            setCodeError(errorMessage(err));
          } else {
            setQuoteError(errorMessage(err));
          }
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [item, quantity, appliedCode, order]);

  const finish = useCallback(
    async (paid: PaymentOrder) => {
      trackEvent("purchase_completed", { kind: paid.kind, amount: paid.amount });
      if (user) {
        try {
          syncFromProfile(await fetchMyProfile(user.id));
        } catch (err) {
          console.error("Failed to refresh profile after payment", err);
        }
      }
      navigate(`/payment-success?order=${encodeURIComponent(paid.id)}`, { replace: true });
    },
    [navigate, syncFromProfile, user],
  );

  if (!item) return null;
  if (configLoading || resuming) {
    return <div className="mx-auto max-w-2xl px-5 py-14 text-center text-sm text-ink-500 sm:px-8">{t("Loading…")}</div>;
  }


  const plan = item.kind === "plan" ? plans.find((p) => p.id === item.plan) : null;
  const pack = item.kind === "pack" ? creditPacks.find((p) => p.id === item.packId) : null;
  const itemName = plan ? t(plan.name) : t("{{label}} pack", { label: t(pack?.label) ?? "" });

  if (order) {
    return (
      <PaymentStep
        order={order}
        onUpdate={setOrder}
        onPaid={finish}
        onRestart={() => {
          setOrder(null);
          setSubmitError(null);
        }}
      />
    );
  }

  const effect = item.kind === "plan" ? planPurchaseEffect(currentPlan, currentPlanEnds, item) : null;
  const currentPlanName = t(plans.find((p) => p.id === currentPlan)?.name ?? currentPlan);
  const day = (d: Date | string) => new Date(d).toLocaleDateString(currentLocale(), { dateStyle: "long" });

  const listAmount = quote?.list_amount ?? null;
  const amount = quote?.amount ?? null;
  const hasDiscount = amount !== null && listAmount !== null && amount < listAmount;

  function changeQuantity(next: number) {
    setQuantity(Math.min(MAX_PACK_QUANTITY, Math.max(MIN_PACK_QUANTITY, next)));
  }

  async function applyCode() {
    const code = codeInput.trim();
    if (!code || !item) return;
    setCodeApplying(true);
    setCodeError(null);
    try {
      setQuote(await quotePayment(toPaymentItem(item, quantity), code));
      setAppliedCode(code);
    } catch (err) {
      setCodeError(errorMessage(err));
    } finally {
      setCodeApplying(false);
    }
  }

  async function startPayment() {
    if (!item || creating) return;
    setCreating(true);
    setSubmitError(null);
    try {
      const created = await createPaymentOrder(toPaymentItem(item, quantity), appliedCode ?? undefined);
      trackEvent("purchase_requested", { kind: item.kind });
      if (created.status === "success") {
        await finish(created);
        return;
      }
      setOrder(created);
    } catch (err) {
      if (isDiscountError(err)) setAppliedCode(null);
      setSubmitError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-5 py-14 sm:px-8">
      <h1 className="text-h2 font-bold tracking-tight text-navy-900">{t("Checkout")}</h1>
      <p className="mt-1.5 text-sm text-ink-500">
        {t("Pay by bank transfer with any banking app. Your plan or credits are added automatically as soon as the transfer arrives.")}</p>

      <div className="mt-7 rounded-[var(--radius-card-lg)] border border-line bg-white p-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">{t("Order summary")}</p>
        <div className="mt-3 flex items-center justify-between border-b border-line pb-4">
          <div>
            <p className="text-sm font-bold text-navy-900">{itemName}</p>
            <p className="text-xs text-ink-500">
              {plan
                ? (item.kind === "plan" && item.billingCycle === "annual" ? t("Billed annually") : t("Billed monthly"))
                : pack
                  ? t("{{n}} credits total · never expire", { n: (pack.checks * quantity).toLocaleString(currentLocale()) })
                  : t("One-time purchase, credits never expire")}
            </p>
          </div>
          <p className="text-sm font-bold text-ink-900">{listAmount === null ? "…" : formatVND(listAmount)}</p>
        </div>

        {item.kind === "pack" && pack && (
          <div className="flex items-center justify-between border-b border-line py-4">
            <div>
              <p className="text-sm font-semibold text-navy-900">{t("Quantity")}</p>
              <p className="text-xs text-ink-500">{formatVND(pack.price)}{" "}{t("per pack")}</p>
            </div>
            <div className="flex items-center gap-1 rounded-full border border-line p-1">
              <button
                type="button"
                onClick={() => changeQuantity(quantity - 1)}
                disabled={quantity <= MIN_PACK_QUANTITY}
                aria-label={t("Decrease quantity")}
                className="flex size-7 items-center justify-center rounded-full text-ink-700 transition-colors hover:bg-surface-tint disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Minus size={13} weight="bold" />
              </button>
              <input
                type="number"
                inputMode="numeric"
                min={MIN_PACK_QUANTITY}
                max={MAX_PACK_QUANTITY}
                value={quantity}
                onChange={(e) => changeQuantity(Number(e.target.value) || MIN_PACK_QUANTITY)}
                aria-label={t("Quantity")}
                className="w-9 border-0 bg-transparent text-center text-sm font-bold text-navy-900 focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <button
                type="button"
                onClick={() => changeQuantity(quantity + 1)}
                disabled={quantity >= MAX_PACK_QUANTITY}
                aria-label={t("Increase quantity")}
                className="flex size-7 items-center justify-center rounded-full text-ink-700 transition-colors hover:bg-surface-tint disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Plus size={13} weight="bold" />
              </button>
            </div>
          </div>
        )}

        <div className="border-b border-line py-4">
          {appliedCode ? (
            <div className="flex items-center gap-2 text-xs">
              <Tag size={14} className="shrink-0 text-success" />
              <span className="font-medium text-success">
                {t("Discount code {{code}} applied.", { code: appliedCode.toUpperCase() })}
              </span>
              <button
                type="button"
                onClick={() => {
                  setAppliedCode(null);
                  setCodeInput("");
                }}
                aria-label={t("Remove discount code")}
                className="ml-auto flex size-6 items-center justify-center rounded-full text-ink-400 hover:bg-surface-tint hover:text-ink-700"
              >
                <X size={12} weight="bold" />
              </button>
            </div>
          ) : (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void applyCode();
              }}
            >
              <Tag size={14} className="shrink-0 text-ink-400" />
              <input
                value={codeInput}
                onChange={(e) => {
                  setCodeInput(e.target.value);
                  setCodeError(null);
                }}
                placeholder={t("Discount code")}
                className="min-w-0 flex-1 rounded-full border border-line bg-surface-tint px-3.5 py-1.5 text-xs placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
              />
              <button
                type="submit"
                disabled={!codeInput.trim() || codeApplying}
                className="shrink-0 rounded-full border border-line px-3.5 py-1.5 text-xs font-semibold text-ink-700 hover:border-brand-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {codeApplying ? t("Applying…") : t("Apply")}
              </button>
            </form>
          )}
          {codeError && <p className="mt-2 text-xs font-medium text-severity-high">{codeError}</p>}
          {quote?.discount?.source === "auto" && (
            <p className="mt-2 text-xs font-medium text-success">{t("Sale price applied.")}</p>
          )}
        </div>

        <div className="flex items-center justify-between pt-4">
          <p className="text-sm font-bold text-navy-900">{t("Total")}</p>
          <div className="flex items-baseline gap-1.5">
            {hasDiscount && listAmount !== null && (
              <span className="text-sm font-semibold text-ink-400 line-through">{formatVND(listAmount)}</span>
            )}
            <p className={cn("text-lg font-extrabold", hasDiscount ? "text-success" : "text-navy-900")}>
              {amount === null ? "…" : formatVND(amount)}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-6 flex items-start gap-3 rounded-[var(--radius-card)] border border-line bg-slate-50 p-4">
        <Bank size={22} weight="duotone" className="mt-0.5 shrink-0 text-brand-600" />
        <div>
          <p className="text-sm font-semibold text-navy-900">{t("Bank transfer (VietQR)")}</p>
          <p className="mt-0.5 text-xs text-ink-500">
            {t("Scan the QR with your banking app, or with MoMo or ZaloPay. No card details needed.")}</p>
        </div>
      </div>

      {effect && (
        <p
          className={cn(
            "mt-4 rounded-[var(--radius-card)] border px-4 py-3 text-sm",
            effect.kind === "replace" ? "border-severity-moderate-line bg-severity-moderate-bg text-ink-700" : "border-line bg-white text-ink-600",
          )}
        >
          {effect.kind === "renew"
            ? t("Renewal: your plan will run until {{date}}. The new term is added to the end of the current one.", { date: day(effect.endsAt) })
            : effect.kind === "replace"
              ? effect.currentEndsAt
                ? t("This replaces your {{current}} plan (active until {{currentEnd}}) from today. Time left on it isn't carried over. The new plan runs until {{date}}.", {
                    current: currentPlanName,
                    currentEnd: day(effect.currentEndsAt),
                    date: day(effect.endsAt),
                  })
                : t("This replaces your {{current}} plan from today. The new plan runs until {{date}}.", { current: currentPlanName, date: day(effect.endsAt) })
              : t("Your plan starts as soon as the payment arrives and runs until {{date}}. Nothing renews automatically.", { date: day(effect.endsAt) })}
        </p>
      )}

      {(submitError || quoteError) && (
        <div className="mt-6 flex items-start gap-3 rounded-[var(--radius-card)] border border-severity-high-line bg-severity-high-bg px-4 py-3.5 text-sm text-severity-high">
          <WarningCircle size={20} weight="fill" className="mt-0.5 shrink-0" />
          <p>{submitError ?? quoteError}</p>
        </div>
      )}

      <div className="mt-7 flex flex-col gap-3">
        <Button
          size="lg"
          loading={creating}
          disabled={amount === null}
          onClick={() => void startPayment()}
          iconLeft={<Lightning size={16} weight="fill" />}
          fullWidth
        >
          {amount === null ? t("Continue to payment") : t("Pay {{amount}}", { amount: formatVND(amount) })}
        </Button>
        <p className="text-center text-xs text-ink-400">
          {t("You'll get a QR code and transfer details on the next step.")}</p>
      </div>
    </div>
  );
}

/** Shows the QR and transfer details, and waits for SePay to confirm. */
function PaymentStep({
  order,
  onUpdate,
  onPaid,
  onRestart,
}: {
  order: PaymentOrder;
  onUpdate: (order: PaymentOrder) => void;
  onPaid: (order: PaymentOrder) => void;
  onRestart: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paidReported = useRef(false);

  const remaining = timeLeft(order.expires_at, now);
  const expired = order.expires_at !== null && remaining === null;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Keep asking until the order leaves "pending". This continues after the
  // QR expires: a transfer that arrives late is still honoured.
  useEffect(() => {
    if (order.status !== "pending") return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const latest = await getPaymentOrder(order.id);
        if (cancelled) return;
        if (latest.status !== order.status) onUpdate(latest);
      } catch (err) {
        // A blip shouldn't end the wait; try again next round.
        console.warn("Order status check failed", err);
      }
      if (!cancelled) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
    };
    timer = window.setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [order.id, order.status, onUpdate]);

  useEffect(() => {
    if (order.status === "success" && !paidReported.current) {
      paidReported.current = true;
      onPaid(order);
    }
  }, [order, onPaid]);

  async function changeOrder() {
    setCancelling(true);
    setError(null);
    try {
      const latest = await cancelPaymentOrder(order.id);
      if (latest.status === "success") {
        onUpdate(latest);
        return;
      }
      onRestart();
    } catch (err) {
      // Already paid or gone: re-read rather than guess.
      if (err instanceof ApiError && err.status === 409) {
        onUpdate(await getPaymentOrder(order.id));
        return;
      }
      setError(errorMessage(err));
    } finally {
      setCancelling(false);
    }
  }

  if (order.status === "success") {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-center px-5 py-24 text-center sm:px-8">
        <CircleNotch size={32} className="animate-spin text-brand-600" />
        <p className="mt-4 text-sm font-semibold text-navy-900">{t("Payment received. Updating your account…")}</p>
      </div>
    );
  }

  if (order.status !== "pending") {
    return (
      <div className="mx-auto max-w-2xl px-5 py-14 sm:px-8">
        <h1 className="text-h2 font-bold tracking-tight text-navy-900">{t("This order was cancelled")}</h1>
        <p className="mt-2 text-sm text-ink-500">
          {t("It may have been replaced by a newer order from another tab. If you already transferred money for it, it will still be applied.")}</p>
        <div className="mt-7">
          <Button size="lg" fullWidth onClick={onRestart}>
            {t("Start a new order")}</Button>
        </div>
      </div>
    );
  }

  const details = order.transfer;

  return (
    <div className="mx-auto max-w-2xl px-5 py-14 sm:px-8">
      <button
        type="button"
        onClick={() => void changeOrder()}
        disabled={cancelling}
        className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-500 hover:text-navy-900 disabled:opacity-50"
      >
        <ArrowLeft size={15} weight="bold" />
        {t("Change order")}
      </button>
      <h1 className="mt-3 text-h2 font-bold tracking-tight text-navy-900">{t("Scan to pay")}</h1>
      <p className="mt-1.5 text-sm text-ink-500">
        {t("Open your banking app, scan the QR and confirm. Keep the transfer content exactly as shown so we can match your payment.")}</p>

      <div className="mt-7 rounded-[var(--radius-card-lg)] border border-line bg-white p-6">
        <div className="flex items-center justify-between border-b border-line pb-4">
          <p className="text-sm font-bold text-navy-900">{describeOrder(order)}</p>
          <p className="text-lg font-extrabold text-navy-900">{formatVND(order.amount)}</p>
        </div>

        {expired || !details ? (
          <div className="mt-5 rounded-[var(--radius-card)] border border-line bg-slate-50 p-5 text-center">
            <p className="text-sm font-semibold text-navy-900">{t("This QR code has expired")}</p>
            <p className="mt-1 text-xs text-ink-500">
              {t("Already transferred? Stay on this page — we'll still confirm it. Otherwise, start a new order.")}</p>
            <Button className="mt-4" variant="outline" loading={cancelling} onClick={() => void changeOrder()}>
              {t("Start a new order")}</Button>
          </div>
        ) : (
          <div className="mt-5 grid gap-6 sm:grid-cols-[220px_1fr] sm:items-start">
            <div className="flex justify-center rounded-2xl border border-dashed border-line bg-white p-3">
              <img src={details.qr_url} alt={t("VietQR code")} className="size-[200px] rounded-xl object-contain" />
            </div>
            <dl className="flex flex-col gap-3 text-sm">
              <DetailRow label={t("Bank")} value={details.bank} />
              <DetailRow label={t("Account number")} value={details.account_number} copy />
              {details.account_name && <DetailRow label={t("Account name")} value={details.account_name} />}
              <DetailRow label={t("Amount")} value={formatVND(details.amount)} copyValue={String(details.amount)} copy />
              <DetailRow label={t("Transfer content")} value={details.content} copy highlight />
            </dl>
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-[var(--radius-control)] bg-brand-100/50 px-4 py-3 text-sm">
          <span className="flex items-center gap-2 font-semibold text-brand-700">
            <CircleNotch size={16} className="animate-spin" />
            {t("Waiting for your transfer…")}
          </span>
          {remaining && (
            <span className="font-mono text-xs text-ink-500">{t("QR valid for {{time}}", { time: remaining })}</span>
          )}
        </div>
      </div>

      {error && <p className="mt-4 text-sm text-severity-high">{error}</p>}
      <p className="mt-5 text-center text-xs text-ink-400">
        {t("This page updates by itself once the payment arrives, usually within a minute.")}</p>
    </div>
  );
}

function DetailRow({
  label,
  value,
  copy = false,
  copyValue,
  highlight = false,
}: {
  label: string;
  value: string;
  copy?: boolean;
  copyValue?: string;
  highlight?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(copyValue ?? value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (e.g. insecure context): the value is still visible.
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 border-b border-line pb-2.5 last:border-0">
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className="flex items-center gap-1.5">
        <span className={cn("font-semibold text-navy-900", highlight && "rounded-md bg-brand-100 px-2 py-0.5 font-mono text-brand-700")}>
          {value}
        </span>
        {copy && (
          <button
            type="button"
            onClick={() => void handleCopy()}
            aria-label={t("Copy {{label}}", { label })}
            className="flex size-7 items-center justify-center rounded-full text-ink-400 transition-colors hover:bg-surface-tint hover:text-ink-700"
          >
            {copied ? <Check size={14} weight="bold" className="text-success" /> : <Copy size={14} />}
          </button>
        )}
      </dd>
    </div>
  );
}
