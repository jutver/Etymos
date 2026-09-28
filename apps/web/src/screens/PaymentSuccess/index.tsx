// Route kept at /payment-success (linked from Checkout and elsewhere), but it
// is no longer a purchase receipt: submitting checkout only files a pending
// `checkout_events` row, so nothing has been granted yet. This screen confirms
// the request was recorded and that an admin still has to approve it.
import { motion } from "motion/react";
import { ArrowRight, HourglassMedium } from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";
import { useAppStore, planLabel } from "../../lib/store";
import { describePurchaseRequest, useMyPendingRequest } from "../../lib/purchaseRequests";
import { t } from "../../lib/i18n";

export default function PaymentSuccessPage() {
  const plan = useAppStore((s) => s.plan);
  const { pending, loading } = useMyPendingRequest();

  return (
    <div className="studio-page mx-auto flex min-h-[calc(100dvh-68px)] max-w-lg flex-col items-center justify-center px-5 py-16 text-center">
      <motion.div
        initial={{ scale: 0.7, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="flex size-20 items-center justify-center rounded-full bg-brand-100 text-brand-600"
      >
        <HourglassMedium size={44} weight="fill" />
      </motion.div>

      <h1 className="mt-6 text-h1 font-bold tracking-tight text-navy-900">{t("Request submitted")}</h1>
      <p className="mt-2 text-body-lg text-ink-600">
        {loading
          ? t("Recording your request…")
          : pending
            ? t("Your request for {{describePurchaseRequest}} is waiting for admin approval.", { describePurchaseRequest: describePurchaseRequest(pending) })
            : t("Your request is waiting for admin approval.")}
      </p>

      <div className="studio-card mt-7 w-full rounded-[var(--radius-card-lg)] border border-line bg-white p-6 text-left">
        <div className="flex items-center justify-between">
          <span className="text-sm text-ink-500">{t("Status")}</span>
          <span className="rounded-full bg-brand-100 px-2.5 py-1 text-xs font-bold text-brand-700">
            {t("Pending review")}</span>
        </div>
        <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
          <span className="text-sm text-ink-500">{t("Current plan")}</span>
          <span className="text-sm font-bold text-navy-900">{t(planLabel(plan))}</span>
        </div>
        <p className="mt-3 border-t border-line pt-3 text-xs text-ink-500">
          {t("Your plan and credits stay unchanged until an admin confirms your payment. You'll see the update here once they do.")}</p>
      </div>

      <div className="mt-8 flex w-full flex-col gap-3">
        <Button as="link" to="/account/plan" size="lg" fullWidth iconRight={<ArrowRight size={18} weight="bold" />}>
          {t("Go to My Plan")}</Button>
        <Button as="link" to="/upload" variant="ghost" fullWidth>
          {t("Back to Upload")}</Button>
      </div>
    </div>
  );
}
