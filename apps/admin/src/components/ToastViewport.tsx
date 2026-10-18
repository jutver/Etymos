import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle, Info, WarningCircle, X, XCircle } from "@phosphor-icons/react";
import type { Toast } from "@etymos/shared";
import { dismissToast, useToasts } from "../lib/toast";
import { t } from "../lib/i18n";

const ICONS: Record<Toast["kind"], ReactNode> = {
  success: <CheckCircle size={20} weight="fill" className="text-success" />,
  info: <Info size={20} weight="fill" className="text-accent" />,
  warning: <WarningCircle size={20} weight="fill" className="text-warning" />,
  error: <XCircle size={20} weight="fill" className="text-destructive" />,
};

// Errors and warnings stay up longer: they usually need reading.
const DURATION_MS: Record<Toast["kind"], number> = { success: 4500, info: 4500, warning: 8000, error: 8000 };

function ToastItem({ toast }: { toast: Toast }) {
  useEffect(() => {
    const timer = window.setTimeout(() => dismissToast(toast.id), DURATION_MS[toast.kind]);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.kind]);

  return (
    <motion.div
      layout
      role={toast.kind === "error" ? "alert" : "status"}
      initial={{ opacity: 0, y: 16, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, transition: { duration: 0.2 } }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="pointer-events-auto flex w-[22rem] max-w-[calc(100vw-2rem)] items-start gap-3 rounded-card border border-border bg-surface p-4 shadow-pop"
    >
      <div className="mt-0.5 shrink-0">{ICONS[toast.kind]}</div>
      <div className="min-w-0 flex-1">
        <p className="text-body font-semibold text-fg">{toast.title}</p>
        {toast.description && <p className="mt-0.5 text-caption text-fg-muted">{toast.description}</p>}
      </div>
      <button
        type="button"
        onClick={() => dismissToast(toast.id)}
        aria-label={t("Dismiss")}
        className="shrink-0 cursor-pointer rounded-full p-1 text-fg-subtle transition hover:bg-surface-raised hover:text-fg"
      >
        <X size={16} />
      </button>
    </motion.div>
  );
}

/** Lower-right stack of admin action notifications; see lib/toast.ts. */
export function ToastViewport() {
  const toasts = useToasts();
  return createPortal(
    <div className="pointer-events-none fixed bottom-5 right-5 z-[100] flex flex-col gap-3">
      <AnimatePresence>
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} />
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  );
}
