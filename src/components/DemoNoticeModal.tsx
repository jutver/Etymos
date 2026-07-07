import { useState } from "react";
import { Sparkle } from "@phosphor-icons/react";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";

const STORAGE_KEY = "etymos-demo-notice-seen";

export function DemoNoticeModal() {
  const [open, setOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    return !window.localStorage.getItem(STORAGE_KEY);
  });

  function dismiss() {
    window.localStorage.setItem(STORAGE_KEY, "1");
    setOpen(false);
  }

  return (
    <Modal open={open} onClose={dismiss} maxWidth="max-w-md" labelledBy="demo-notice-title">
      <div className="p-7 text-center sm:p-8">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-brand-100 text-brand-600">
          <Sparkle size={22} weight="fill" />
        </div>
        <h2 id="demo-notice-title" className="mt-4 text-h3 font-bold tracking-tight text-navy-900">
          You're viewing a demo
        </h2>
        <p className="mt-2.5 text-sm leading-relaxed text-ink-600">
          Etymos is a prototype, not a finished product yet. Signup, plans, and document checks all
          work, but some results are simulated for demonstration purposes.
        </p>
        <Button fullWidth size="lg" className="mt-6" onClick={dismiss}>
          Got it
        </Button>
      </div>
    </Modal>
  );
}
