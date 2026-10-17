import { useEffect, useState } from "react";
import { announcementImageUrl } from "@etymos/shared";
import { X } from "@phosphor-icons/react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { dismissAnnouncement, dismissedAnnouncements, useAnnouncements } from "../../lib/announcements";
import { t } from "../../lib/i18n";

/**
 * The latest live pop-up announcement: title, text, image, or any mix.
 * Shown once per browser. Waits while another dialog (the closed-beta notice,
 * say) is open, so two never stack.
 */
export function AnnouncementPopup() {
  const { popup } = useAnnouncements();
  const [closedId, setClosedId] = useState<string | null>(null);
  const [otherDialogOpen, setOtherDialogOpen] = useState(true);
  const [imageFailed, setImageFailed] = useState(false);

  const pending = popup && popup.id !== closedId && !dismissedAnnouncements().has(popup.id) ? popup : null;

  useEffect(() => {
    if (!pending) return;
    const check = () => setOtherDialogOpen(document.querySelector('[role="dialog"]') !== null);
    check();
    const timer = window.setInterval(check, 1000);
    return () => window.clearInterval(timer);
  }, [pending]);

  useEffect(() => setImageFailed(false), [popup?.id]);

  // Once this one is open it is itself a dialog: keep it open.
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (pending && !otherDialogOpen) setShown(pending.id);
  }, [pending, otherDialogOpen]);

  if (!pending || shown !== pending.id) return null;

  function close() {
    dismissAnnouncement(pending!.id);
    setClosedId(pending!.id);
  }

  const image = imageFailed ? null : announcementImageUrl(pending.image_path);
  const hasText = Boolean(pending.title?.trim() || pending.message.trim());

  return (
    <Modal open onClose={close} maxWidth="max-w-lg" labelledBy={pending.title ? "announcement-popup-title" : undefined}>
      {/* Own close button: it has to stay visible on top of an image. */}
      <button
        type="button"
        onClick={close}
        aria-label={t("Close")}
        className="absolute right-3 top-3 z-10 flex size-9 items-center justify-center rounded-full bg-white/90 text-ink-600 shadow-[var(--shadow-card)] transition-colors hover:bg-white hover:text-ink-900"
      >
        <X size={18} />
      </button>
      {image && (
        <img
          src={image}
          alt={pending.title ?? ""}
          onError={() => setImageFailed(true)}
          className="block max-h-[55dvh] w-full bg-surface-tint object-cover"
        />
      )}
      <div className={hasText ? "p-7 sm:p-8" : "p-5"}>
        {pending.title?.trim() && (
          <h2 id="announcement-popup-title" className="pr-8 text-h3 font-bold tracking-tight text-navy-900">
            {t(pending.title)}
          </h2>
        )}
        {pending.message.trim() && (
          <p className="mt-2.5 whitespace-pre-line text-sm leading-relaxed text-ink-600">{t(pending.message)}</p>
        )}
        <Button fullWidth size="lg" className={hasText ? "mt-6" : ""} onClick={close}>
          {t("Got it")}
        </Button>
      </div>
    </Modal>
  );
}
