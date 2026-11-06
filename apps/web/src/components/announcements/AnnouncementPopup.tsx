import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  announcementButtonLabel,
  announcementImageUrl,
  announcementText,
  isAnnouncementLinkValid,
  type Announcement,
} from "@etymos/shared";
import { X } from "@phosphor-icons/react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { dismissAnnouncement, dismissedAnnouncements, recordAnnouncementSeen, useAnnouncements } from "../../lib/announcements";
import { useAuth } from "../../lib/auth";
import { t, useLanguage } from "../../lib/i18n";

/** The signed-in home page (APP_HOME in App.tsx) and the signed-out landing page. */
const HOME_PATH = "/upload";
const LANDING_PATH = "/";

/** Whether this pop-up belongs on the page the visitor is on now. */
function onItsPage(popup: Announcement, signedIn: boolean, pathname: string): boolean {
  const home = signedIn && pathname === HOME_PATH;
  const landing = !signedIn && pathname === LANDING_PATH;
  if (popup.popup_placement === "home") return home;
  if (popup.popup_placement === "landing") return landing;
  return home || landing;
}

/**
 * Live pop-up announcements, one at a time: personal messages an admin sent
 * this account, then the latest global pop-up. Title, text, image, or any mix.
 * Opens on the page the admin chose (signed-in home, signed-out landing, or
 * both), once per browser. Waits while another dialog (the Terms gate, say)
 * is open, so two never stack. The button closes it, or follows the admin's
 * link when one is set.
 */
export function AnnouncementPopup() {
  const { popups } = useAnnouncements();
  const [closedIds, setClosedIds] = useState<string[]>([]);
  const [otherDialogOpen, setOtherDialogOpen] = useState(true);
  const [imageFailed, setImageFailed] = useState(false);
  const lang = useLanguage();
  const { user, loading } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  // One at a time: the first not yet closed here (personal messages come first).
  const dismissed = dismissedAnnouncements();
  const unseen = popups.find((p) => !closedIds.includes(p.id) && !dismissed.has(p.id)) ?? null;
  // Until auth settles, "signed out on /" may really be a signed-in user about to be sent home.
  const pending = unseen && !loading && onItsPage(unseen, Boolean(user), pathname) ? unseen : null;

  useEffect(() => {
    if (!pending) return;
    const check = () => setOtherDialogOpen(document.querySelector('[role="dialog"]') !== null);
    check();
    const timer = window.setInterval(check, 1000);
    return () => window.clearInterval(timer);
  }, [pending]);

  useEffect(() => setImageFailed(false), [unseen?.id]);

  // Once this one is open it is itself a dialog: keep it open, even if the
  // visitor moves to another page behind it.
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (pending && !otherDialogOpen) setShown(pending.id);
  }, [pending, otherDialogOpen]);

  const open = unseen && shown === unseen.id ? unseen : null;
  if (!open) return null;

  function close() {
    dismissAnnouncement(open!.id);
    recordAnnouncementSeen(open!);
    setClosedIds((ids) => [...ids, open!.id]);
  }

  // The database only accepts safe links; checked again here all the same.
  const link = open.button_url && isAnnouncementLinkValid(open.button_url) ? open.button_url : null;

  function pressButton() {
    close();
    if (!link) return;
    if (link.startsWith("/")) navigate(link);
    else window.location.assign(link);
  }

  const image = imageFailed ? null : announcementImageUrl(open.image_path);
  const { title, message } = announcementText(open, lang);
  const buttonLabel = announcementButtonLabel(open, lang);
  const hasText = Boolean(title || message);

  return (
    <Modal open onClose={close} maxWidth="max-w-lg" labelledBy={title ? "announcement-popup-title" : undefined}>
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
          alt={title}
          onError={() => setImageFailed(true)}
          className="block max-h-[55dvh] w-full bg-surface-tint object-cover"
        />
      )}
      <div className={hasText ? "p-7 sm:p-8" : "p-5"}>
        {title && (
          <h2 id="announcement-popup-title" className="pr-8 text-h3 font-bold tracking-tight text-navy-900">
            {t(title)}
          </h2>
        )}
        {message && <p className="mt-2.5 whitespace-pre-line text-sm leading-relaxed text-ink-600">{t(message)}</p>}
        <Button fullWidth size="lg" className={hasText ? "mt-6" : ""} onClick={pressButton}>
          {buttonLabel ?? t("Got it")}
        </Button>
      </div>
    </Modal>
  );
}
