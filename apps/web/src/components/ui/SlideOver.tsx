import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { m, AnimatePresence } from "motion/react";

interface SlideOverProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  widthClass?: string;
}

export function SlideOver({ open, onClose, children, widthClass = "max-w-xl" }: SlideOverProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <m.div
            className="absolute inset-0 bg-navy-900/45 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />
          <m.div
            className={`relative z-10 flex h-full w-full ${widthClass} flex-col bg-white shadow-[var(--shadow-pop)]`}
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          >
            {children}
          </m.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
