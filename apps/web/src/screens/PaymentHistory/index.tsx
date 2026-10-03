import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Receipt, WarningCircle } from "@phosphor-icons/react";
import { cn, formatVND } from "@etymos/shared";
import { Button } from "../../components/ui/Button";
import { useAuth } from "../../lib/auth";
import { useAppStore } from "../../lib/store";
import { describeOrder } from "../../lib/payments";
import { fetchMyOrders, orderState, totalPaid, type HistoryOrder, type OrderState } from "../../lib/paymentHistory";
import { t, tr, currentLocale } from "../../lib/i18n";

const STATE_LABELS: Record<OrderState, string> = {
  paid: tr("Paid"),
  awaiting: tr("Awaiting payment"),
  expired: tr("Not paid"),
  cancelled: tr("Cancelled"),
  declined: tr("Declined"),
};

const STATE_CLASSES: Record<OrderState, string> = {
  paid: "bg-success-bg text-success",
  awaiting: "bg-brand-100 text-brand-700",
  expired: "bg-surface-muted text-ink-500",
  cancelled: "bg-surface-muted text-ink-500",
  declined: "bg-severity-high-bg text-severity-high",
};

export default function PaymentHistoryPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const selectCheckoutItem = useAppStore((s) => s.selectCheckoutItem);
  const [orders, setOrders] = useState<HistoryOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showUnpaid, setShowUnpaid] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    fetchMyOrders(user.id)
      .then((rows) => !cancelled && setOrders(rows))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [user]);

  const visible = useMemo(() => {
    if (!orders) return [];
    return showUnpaid ? orders : orders.filter((o) => ["paid", "awaiting"].includes(orderState(o)));
  }, [orders, showUnpaid]);
  const hiddenCount = (orders?.length ?? 0) - visible.length;

  function continuePayment(order: HistoryOrder) {
    selectCheckoutItem(
      order.kind === "plan"
        ? { kind: "plan", plan: order.plan_tier ?? "student", billingCycle: order.billing_cycle ?? "monthly" }
        : { kind: "pack", packId: order.pack_id ?? "pack-standard" },
    );
    navigate("/checkout");
  }

  return (
    <div className="studio-page mx-auto max-w-3xl px-5 py-10 sm:px-8">
      <Link to="/account/plan" className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-500 hover:text-navy-900">
        <ArrowLeft size={15} weight="bold" />
        {t("My Plan")}
      </Link>
      <h1 className="mt-3 text-h1 font-bold tracking-tight text-navy-900">{t("Payment history")}</h1>
      <p className="mt-1.5 text-sm text-ink-500">{t("Every plan and credit purchase on your account.")}</p>

      {error && (
        <div className="mt-6 flex items-start gap-3 rounded-[var(--radius-card)] border border-severity-high-line bg-severity-high-bg px-4 py-3.5 text-sm text-severity-high">
          <WarningCircle size={20} weight="fill" className="mt-0.5 shrink-0" />
          <p>{t("Couldn't load your payments.")} {error}</p>
        </div>
      )}

      {!orders && !error && <p className="mt-10 text-center text-sm text-ink-500">{t("Loading…")}</p>}

      {orders && (
        <>
          <div className="studio-card mt-7 flex items-center justify-between rounded-[var(--radius-card)] border border-line bg-white px-5 py-4">
            <span className="text-sm text-ink-500">{t("Total paid")}</span>
            <span className="text-lg font-extrabold text-navy-900">{formatVND(totalPaid(orders))}</span>
          </div>

          {visible.length === 0 ? (
            <div className="mt-6 flex flex-col items-center rounded-[var(--radius-card-lg)] border border-dashed border-line bg-surface-tint px-6 py-12 text-center">
              <Receipt size={28} className="text-ink-300" />
              <p className="mt-3 text-sm font-semibold text-navy-900">{t("No payments yet")}</p>
              <p className="mt-1 text-sm text-ink-500">{t("Plans and credit packs you buy will show up here.")}</p>
              <Button as="link" to="/pricing" className="mt-5" size="sm">
                {t("See plans")}</Button>
            </div>
          ) : (
            <ul className="studio-card mt-6 divide-y divide-line overflow-hidden rounded-[var(--radius-card-lg)] border border-line bg-white">
              {visible.map((o) => {
                const state = orderState(o);
                return (
                  <li key={o.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-navy-900">{describeOrder(o)}</p>
                      <p className="mt-0.5 text-xs text-ink-500">
                        {new Date(o.paid_at ?? o.created_at).toLocaleString(currentLocale(), { dateStyle: "medium", timeStyle: "short" })}
                        {o.payment_code && <span className="font-mono"> · {o.payment_code}</span>}
                      </p>
                    </div>
                    <span className={cn("rounded-full px-2.5 py-1 text-xs font-bold", STATE_CLASSES[state])}>
                      {t(STATE_LABELS[state])}
                    </span>
                    <span className="w-28 text-right text-sm font-bold text-navy-900">
                      {formatVND(state === "paid" ? Number(o.paid_amount ?? o.amount) : o.amount)}
                    </span>
                    <span className="w-24 text-right">
                      {state === "paid" && o.payment_method === "sepay" ? (
                        <Link to={`/payment-success?order=${o.id}`} className="text-xs font-semibold text-brand-600 hover:underline">
                          {t("Receipt")}</Link>
                      ) : state === "awaiting" ? (
                        <button type="button" onClick={() => continuePayment(o)} className="text-xs font-semibold text-brand-600 hover:underline">
                          {t("Pay now")}</button>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {(hiddenCount > 0 || showUnpaid) && (
            <button
              type="button"
              onClick={() => setShowUnpaid((v) => !v)}
              className="mt-4 text-sm font-semibold text-ink-500 hover:text-navy-900"
            >
              {showUnpaid ? t("Hide unpaid orders") : t("Show {{count}} unpaid or cancelled orders", { count: hiddenCount })}
            </button>
          )}
        </>
      )}
    </div>
  );
}
