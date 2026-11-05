import { useState } from "react";
import { Desktop } from "@phosphor-icons/react";
import { Modal, ModalCloseButton } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { t } from "../../lib/i18n";

const SEEN_KEY = "etymos.report.desktopHintSeen";

/** Phone-sized screens only; tablets and up get the full layout. */
function isPhone() {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
}

function alreadySeen() {
  try {
    return window.localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Tells phone users once (per browser) that the report works best on a
 * computer, where the document and its sources sit side by side. The report
 * still works on the phone; this is advice, not a gate.
 */
export function DesktopHintDialog() {
  const [open, setOpen] = useState(() => isPhone() && !alreadySeen());

  function close() {
    setOpen(false);
    try {
      window.localStorage.setItem(SEEN_KEY, "1");
    } catch {
      // Private mode or blocked storage: it may show again next time, which is fine.
    }
  }

  return (
    <Modal open={open} onClose={close} maxWidth="max-w-sm" labelledBy="desktop-hint-title">
      <div className="relative p-6 text-center">
        <ModalCloseButton onClose={close} />
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-brand-100 text-brand-600">
          <Desktop size={24} weight="bold" />
        </div>
        <h2 id="desktop-hint-title" className="mt-4 text-h3 font-bold text-navy-900">
          {t("Best viewed on a computer")}</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-500">
          {t("You can read your report here, but a computer shows the document and every matched source side by side, and makes editing much easier.")}</p>
        <Button className="mt-6 w-full" onClick={close}>
          {t("Continue on phone")}</Button>
      </div>
    </Modal>
  );
}
