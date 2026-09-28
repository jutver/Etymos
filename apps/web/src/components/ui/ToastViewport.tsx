import { useEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import { CheckCircle, Info, WarningCircle, XCircle, X } from "@phosphor-icons/react";
import { useAppStore } from "../../lib/store";
import { cn } from "@etymos/shared";
import type { Toast } from "@etymos/shared";
import { t as tl } from "../../lib/i18n";

const iconFor: Record<Toast["kind"], React.ReactNode> = {
  success: <CheckCircle size={20} weight="fill" className="text-success" />,
  info: <Info size={20} weight="fill" className="text-brand-500" />,
  warning: <WarningCircle size={20} weight="fill" className="text-severity-moderate" />,
  error: <XCircle size={20} weight="fill" className="text-severity-high" />,
};

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useAppStore((s) => s.dismissToast);

  useEffect(() => {
    const t = setTimeout(() => dismiss(toast.id), 4500);
    return () => clearTimeout(t);
  }, [toast.id, dismiss]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, transition: { duration: 0.2 } }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        "studio-card pointer-events-auto flex w-[22rem] max-w-[calc(100vw-2rem)] items-start gap-3 rounded-[var(--radius-card)] border border-line bg-white p-4 shadow-[var(--shadow-card-hover)]",
      )}
    >
      <div className="mt-0.5 shrink-0">{iconFor[toast.kind]}</div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink-900">{tl(toast.title)}</p>
        {toast.description && (
          <p className="mt-0.5 text-sm text-ink-500">{tl(toast.description)}</p>
        )}
      </div>
      <button
        onClick={() => dismiss(toast.id)}
        aria-label={tl("Dismiss")}
        className="shrink-0 rounded-full p-1 text-ink-300 hover:bg-surface-muted hover:text-ink-700"
      >
        <X size={16} />
      </button>
    </motion.div>
  );
}

export function ToastViewport() {
  const toasts = useAppStore((s) => s.toasts);

  return createPortal(
    <div className="pointer-events-none fixed bottom-5 right-5 z-[100] flex flex-col gap-3">
      <AnimatePresence>
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} />
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  );
}
