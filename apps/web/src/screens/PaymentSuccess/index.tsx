// /payment-success?order=<id> is the receipt for a SePay order that has been
// paid (Checkout sends the user here once the transfer is confirmed). Without
// an order id there is nothing to show, so it goes to My Plan.
import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { motion } from "motion/react";
import { ArrowRight, CheckCircle, HourglassMedium } from "@phosphor-icons/react";
import { formatVND } from "@etymos/shared";
import { Button } from "../../components/ui/Button";
import { useAppStore, planLabel } from "../../lib/store";
import { getPaymentOrder, type PaymentOrder } from "../../lib/api";
import { describeOrder } from "../../lib/payments";
import { t, currentLocale } from "../../lib/i18n";

export default function PaymentSuccessPage() {
  const [params] = useSearchParams();
  const orderId = params.get("order");
  return orderId ? <PaidReceipt orderId={orderId} /> : <Navigate to="/account/plan" replace />;
}

function PaidReceipt({ orderId }: { orderId: string }) {
  const plan = useAppStore((s) => s.plan);
  const [order, setOrder] = useState<PaymentOrder | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getPaymentOrder(orderId)
      .then((o) => !cancelled && setOrder(o))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  const paid = order?.status === "success";

  return (
    <Shell
      icon={paid || !order ? <CheckCircle size={44} weight="fill" /> : <HourglassMedium size={44} weight="fill" />}
      title={!order || paid ? t("Payment received") : t("Waiting for your payment")}
      subtitle={
        failed
          ? t("We couldn't load this order. Check My Plan for your current balance.")
          : !order
            ? t("Loading…")
            : paid
              ? t("Thanks! {{item}} is now active on your account.", { item: describeOrder(order) })
              : t("We haven't received the transfer for this order yet.")
      }
    >
      {order && (
        <div className="studio-card mt-7 w-full rounded-[var(--radius-card-lg)] border border-line bg-white p-6 text-left">
          <Row label={t("Order")} value={order.payment_code ?? order.id.slice(0, 8)} mono />
          <Row label={t("Item")} value={describeOrder(order)} />
          <Row label={t("Amount paid")} value={formatVND(order.amount)} />
          {order.paid_at && (
            <Row label={t("Paid on")} value={new Date(order.paid_at).toLocaleString(currentLocale())} />
          )}
          <Row label={t("Current plan")} value={t(planLabel(plan))} />
        </div>
      )}
    </Shell>
  );
}


function Shell({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="studio-page mx-auto flex min-h-[calc(100dvh-68px)] max-w-lg flex-col items-center justify-center px-5 py-16 text-center">
      <motion.div
        initial={{ scale: 0.7, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="flex size-20 items-center justify-center rounded-full bg-brand-100 text-brand-600"
      >
        {icon}
      </motion.div>

      <h1 className="mt-6 text-h1 font-bold tracking-tight text-navy-900">{title}</h1>
      <p className="mt-2 text-body-lg text-ink-600">{subtitle}</p>

      {children}

      <div className="mt-8 flex w-full flex-col gap-3">
        <Button as="link" to="/account/plan" size="lg" fullWidth iconRight={<ArrowRight size={18} weight="bold" />}>
          {t("Go to My Plan")}</Button>
        <Button as="link" to="/upload" variant="ghost" fullWidth>
          {t("Back to Upload")}</Button>
      </div>
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line py-2.5 first:pt-0 last:border-0 last:pb-0">
      <span className="text-sm text-ink-500">{label}</span>
      <span className={mono ? "font-mono text-sm font-bold text-navy-900" : "text-sm font-bold text-navy-900"}>{value}</span>
    </div>
  );
}
