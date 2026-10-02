import { useEffect, useRef, useState, type FormEvent } from "react";
import { EnvelopeSimple, WarningCircle } from "@phosphor-icons/react";
import { Modal, ModalCloseButton } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { CodeInput } from "../../components/auth/CodeInput";
import { ApiError, confirmRecoveryEmail, type RecoveryEmailStatus } from "../../lib/api";
import { t } from "../../lib/i18n";

/** Matches the backend's minimum gap between two emails to one address. */
const RESEND_COOLDOWN_SECONDS = 60;

/**
 * Pop-up for confirming a recovery email with the 6-digit code the backend
 * just emailed it. Opened by the profile page right after "Save", or later
 * from "Enter code" while the address is still waiting for confirmation.
 */
export function RecoveryCodeDialog({
  open,
  email,
  justSent,
  onClose,
  onConfirmed,
  onResend,
}: {
  open: boolean;
  email: string;
  /** True when a code was sent moments ago, so "send a new code" starts on cooldown. */
  justSent: boolean;
  onClose: () => void;
  onConfirmed: (status: RecoveryEmailStatus) => void;
  /** Sends a fresh code; rejects with a message to show on failure. */
  onResend: () => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [resending, setResending] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!open) return;
    setCode("");
    setError(null);
    setNotice(null);
    setCooldown(justSent ? RESEND_COOLDOWN_SECONDS : 0);
  }, [open, justSent]);

  useEffect(() => {
    if (!open || cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [open, cooldown]);

  async function handleConfirm(e: FormEvent) {
    e.preventDefault();
    if (code.length !== 6 || inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setNotice(null);
    setVerifying(true);
    try {
      onConfirmed(await confirmRecoveryEmail(code));
    } catch (err) {
      setCode("");
      setError(confirmErrorMessage(err));
    } finally {
      inFlight.current = false;
      setVerifying(false);
    }
  }

  async function handleResend() {
    setError(null);
    setNotice(null);
    setResending(true);
    try {
      await onResend();
      setCode("");
      setNotice(t("We sent a new code. Use the latest one."));
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Something went wrong."));
    } finally {
      setResending(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-md" labelledBy="recovery-code-title">
      <ModalCloseButton onClose={onClose} />
      <div className="p-7 sm:p-8">
        <div className="flex size-12 items-center justify-center rounded-full bg-brand-100 text-brand-600">
          <EnvelopeSimple size={24} weight="fill" />
        </div>
        <h2 id="recovery-code-title" className="mt-4 text-lg font-bold tracking-tight text-navy-900">
          {t("Confirm your recovery email")}
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-ink-600">
          {t("Enter the 6-digit code we sent to {{email}}. It expires in 30 minutes.", { email })}
        </p>

        {error && (
          <div className="mt-4 flex items-start gap-2.5 rounded-[var(--radius-control)] border border-severity-high-line bg-severity-high-bg px-4 py-3 text-sm text-severity-high">
            <WarningCircle size={18} weight="fill" className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {notice && !error && <p className="mt-4 text-sm text-green-700">{notice}</p>}

        <form onSubmit={handleConfirm} className="mt-5 flex flex-col gap-3">
          <CodeInput value={code} onChange={setCode} autoFocus />
          <Button type="submit" size="lg" fullWidth loading={verifying} disabled={code.length !== 6}>
            {t("Confirm")}
          </Button>
        </form>

        <div className="mt-4 text-center text-sm">
          <button
            type="button"
            onClick={handleResend}
            disabled={cooldown > 0 || resending}
            className="font-semibold text-brand-600 hover:underline disabled:cursor-not-allowed disabled:text-ink-400 disabled:no-underline"
          >
            {cooldown > 0 ? t("Send a new code in {{seconds}}s", { seconds: cooldown }) : t("Send a new code")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function confirmErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return err instanceof Error ? err.message : t("Something went wrong.");
  switch (err.message) {
    case "wrong_code":
      return t("That code isn't right. Check the email and try again.");
    case "expired":
      return t("This code has expired. Send a new one.");
    case "too_many_attempts":
      return t("Too many wrong tries, so that code no longer works. Send a new one.");
    case "no_code":
      return t("There's no active code for this address. Send a new one.");
    default:
      return err.message;
  }
}
