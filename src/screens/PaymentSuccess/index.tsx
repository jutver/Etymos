import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { ArrowRight, CheckCircle } from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";
import { useAppStore, planLabel } from "../../lib/store";
import { PLANS } from "../../lib/mockData";

export default function PaymentSuccessPage() {
  const navigate = useNavigate();
  const plan = useAppStore((s) => s.plan);
  const credits = useAppStore((s) => s.credits);
  const pendingCheckoutItem = useAppStore((s) => s.pendingCheckoutItem);
  const hasPendingCheck = useAppStore((s) => s.hasPendingCheck);
  const pendingDocLabel = useAppStore((s) => s.pendingDocLabel);
  const requestCheck = useAppStore((s) => s.requestCheck);
  const clearPendingCheck = useAppStore((s) => s.clearPendingCheck);

  const purchasedPlan =
    pendingCheckoutItem?.kind === "plan" ? PLANS.find((p) => p.id === pendingCheckoutItem.plan) : null;

  function resumeCheck() {
    const label = pendingDocLabel ?? undefined;
    clearPendingCheck();
    requestCheck(label);
    navigate("/analyzing", { state: { docLabels: label ? [label] : undefined } });
  }

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-68px)] max-w-lg flex-col items-center justify-center px-5 py-16 text-center">
      <motion.div
        initial={{ scale: 0.7, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="flex size-20 items-center justify-center rounded-full bg-success-bg text-success"
      >
        <CheckCircle size={44} weight="fill" />
      </motion.div>

      <h1 className="mt-6 text-h1 font-bold tracking-tight text-navy-900">Payment successful</h1>
      <p className="mt-2 text-body-lg text-ink-600">
        {purchasedPlan
          ? `You're now on ${purchasedPlan.name}.`
          : `${credits} credits have been added to your account.`}
      </p>

      <div className="mt-7 w-full rounded-[var(--radius-card-lg)] border border-line bg-white p-6 text-left">
        <div className="flex items-center justify-between">
          <span className="text-sm text-ink-500">Current plan</span>
          <span className="text-sm font-bold text-navy-900">{planLabel(plan)}</span>
        </div>
        <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
          <span className="text-sm text-ink-500">Credit balance</span>
          <span className="text-sm font-bold text-navy-900">{credits} checks</span>
        </div>
      </div>

      <div className="mt-8 flex w-full flex-col gap-3">
        {hasPendingCheck || pendingDocLabel ? (
          <Button size="lg" fullWidth onClick={resumeCheck} iconRight={<ArrowRight size={18} weight="bold" />}>
            Resume checking {pendingDocLabel ?? "your document"}
          </Button>
        ) : (
          <Button as="link" to="/upload" size="lg" fullWidth iconRight={<ArrowRight size={18} weight="bold" />}>
            Go to Upload
          </Button>
        )}
        <Button as="link" to="/history" variant="ghost" fullWidth>
          View my history
        </Button>
      </div>
    </div>
  );
}
