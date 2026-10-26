import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation } from "react-router-dom";
import {
  ChatCircleDots,
  CheckCircle,
  FacebookLogo,
  MagnifyingGlass,
  TiktokLogo,
  UsersThree,
  type Icon,
} from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { Modal, ModalCloseButton } from "./ui/Modal";
import { Button } from "./ui/Button";
import { POLICIES } from "./legal/policies";
import { t, tr } from "../lib/i18n";
import { OTHER_TEXT_MAX, referralSurveyDone, submitReferralSurvey, type ReferralSource } from "../lib/referralSurvey";

const OPTIONS: { source: ReferralSource; label: string; Icon: Icon }[] = [
  { source: "facebook", label: tr("Facebook"), Icon: FacebookLogo },
  { source: "tiktok", label: tr("TikTok"), Icon: TiktokLogo },
  { source: "friend", label: tr("Friends or classmates"), Icon: UsersThree },
  { source: "search", label: tr("Google or another search engine"), Icon: MagnifyingGlass },
  { source: "other", label: tr("Other"), Icon: ChatCircleDots },
];

/** Pages the survey stays out of: the sign-in flows, which must finish
 * uninterrupted, and the policies. */
const EXEMPT_PATHS = [
  ...POLICIES.map((p) => p.path),
  "/login",
  "/signup",
  "/verify-email",
  "/auth/callback",
  "/email-verified",
  "/forgot-password",
  "/reset-password",
  "/recover-account",
];

/** Give the first page a moment before asking anything. */
const OPEN_DELAY_MS = 4000;

/**
 * Asks a first-time visitor how they found Etymos, once per browser. Waits
 * while another dialog (the closed-beta notice, the Terms gate, an
 * announcement) is open, so two never stack. Closing it counts as a skip.
 */
export function ReferralSurvey() {
  const { pathname } = useLocation();
  const [pending, setPending] = useState(() => !referralSurveyDone());
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<ReferralSource | null>(null);
  const [otherText, setOtherText] = useState("");
  const [thanked, setThanked] = useState(false);
  const otherRef = useRef<HTMLInputElement>(null);
  const exempt = EXEMPT_PATHS.includes(pathname);

  useEffect(() => {
    if (!pending || open || exempt) return;
    let timer = 0;
    const tryOpen = () => {
      if (document.querySelector('[role="dialog"]') !== null) {
        timer = window.setTimeout(tryOpen, 1000);
        return;
      }
      setOpen(true);
    };
    timer = window.setTimeout(tryOpen, OPEN_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [pending, open, exempt]);

  useEffect(() => {
    if (source === "other") otherRef.current?.focus();
  }, [source]);

  function finish(answer: ReferralSource | null) {
    void submitReferralSurvey(answer, otherText);
    setPending(false);
    if (answer) setThanked(true);
    else setOpen(false);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (source) finish(source);
  }

  // Closing after answering just dismisses the thank-you; closing before is a skip.
  // Modal re-runs its focus effect when onClose changes, which would pull focus
  // out of the "Other" field on every keystroke, so hand it a stable callback.
  const closeRef = useRef(() => {});
  closeRef.current = () => (thanked ? setOpen(false) : finish(null));
  const close = useCallback(() => closeRef.current(), []);

  return (
    <Modal open={open} onClose={close} maxWidth="max-w-md" labelledBy="referral-survey-title">
      <ModalCloseButton onClose={close} />
      {thanked ? (
        <div className="p-7 text-center sm:p-8">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-brand-100 text-brand-600">
            <CheckCircle size={24} weight="fill" />
          </div>
          <h2 id="referral-survey-title" className="mt-4 text-h3 font-bold tracking-tight text-navy-900">
            {t("Thanks for telling us!")}</h2>
          <p className="mt-2.5 text-sm leading-relaxed text-ink-600">
            {t("It helps us reach more students and researchers like you.")}</p>
          <Button fullWidth size="lg" className="mt-6" onClick={() => setOpen(false)}>
            {t("Continue")}</Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="p-7 sm:p-8">
          <h2 id="referral-survey-title" className="pr-8 text-h3 font-bold tracking-tight text-navy-900">
            {t("How did you hear about Etymos?")}</h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-600">
            {t("One quick question — it helps us know where to share Etymos next.")}</p>

          <div role="radiogroup" aria-labelledby="referral-survey-title" className="mt-5 space-y-2">
            {OPTIONS.map(({ source: value, label, Icon }) => {
              const selected = source === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setSource(value)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-[var(--radius-control)] border px-4 py-3 text-left text-sm font-medium transition-colors",
                    selected
                      ? "border-brand-500 bg-brand-100/60 text-navy-900"
                      : "border-line bg-white text-ink-700 hover:border-brand-300 hover:bg-surface-tint",
                  )}
                >
                  <Icon size={20} weight={selected ? "fill" : "regular"} className={selected ? "text-brand-600" : "text-ink-400"} />
                  {t(label)}
                </button>
              );
            })}
          </div>

          {source === "other" && (
            <input
              ref={otherRef}
              value={otherText}
              maxLength={OTHER_TEXT_MAX}
              onChange={(e) => setOtherText(e.target.value)}
              placeholder={t("Where did you find us? (optional)")}
              aria-label={t("Where did you find us? (optional)")}
              className="mt-3 w-full rounded-[var(--radius-control)] border border-line bg-white px-3.5 py-2.5 text-sm placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          )}

          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="ghost" size="lg" className="sm:flex-1" onClick={() => finish(null)}>
              {t("Skip")}</Button>
            <Button type="submit" size="lg" className="sm:flex-1" disabled={!source}>
              {t("Submit")}</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
