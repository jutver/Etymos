import { useState } from "react";
import { Flask } from "@phosphor-icons/react";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";

const STORAGE_KEY = "etymos-closed-beta-notice-seen";

/**
 * Landing-page notice that Etymos is an early build in closed beta. Purely
 * informational — dismissing it (or never seeing it) does not gate anything,
 * the landing page stays fully browsable either way.
 */
export function ClosedBetaModal() {
  const [open, setOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    return !window.localStorage.getItem(STORAGE_KEY);
  });

  function dismiss() {
    window.localStorage.setItem(STORAGE_KEY, "1");
    setOpen(false);
  }

  return (
    <Modal open={open} onClose={dismiss} maxWidth="max-w-md" labelledBy="closed-beta-title">
      <div className="p-7 text-center sm:p-8">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-brand-100 text-brand-600">
          <Flask size={22} weight="fill" />
        </div>
        <h2 id="closed-beta-title" className="mt-4 text-h3 font-bold tracking-tight text-navy-900">
          Etymos is in closed beta
        </h2>
        <p className="mt-2.5 text-sm leading-relaxed text-ink-600">
          This is an early version of the product, open to a small group of invited users while we
          refine it. You're welcome to look around — signing up adds you to the waitlist, and we'll
          let you in as we widen access. Expect rough edges, and thank you for the patience.
        </p>
        <Button fullWidth size="lg" className="mt-6" onClick={dismiss}>
          Got it
        </Button>
      </div>
    </Modal>
  );
}
