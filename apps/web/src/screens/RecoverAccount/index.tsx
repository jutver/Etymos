import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Envelope, WarningCircle } from "@phosphor-icons/react";
import { supabase } from "@etymos/shared";
import { Button } from "../../components/ui/Button";
import { AuthResultCard } from "../../components/auth/AuthResultCard";
import { CodeInput } from "../../components/auth/CodeInput";
import { NewPasswordForm } from "../../components/auth/NewPasswordForm";
import { ApiError, requestRecoveryCode, verifyRecoveryCode, type RecoveryAccount } from "../../lib/api";
import { t } from "../../lib/i18n";

/** The backend refuses a second email to the same address within 60 seconds. */
const RESEND_COOLDOWN_SECONDS = 60;

type Step = "email" | "code" | "choose" | "password" | "done";

/**
 * Account recovery for someone who can't reach their login email: a 6-digit
 * code goes to the recovery email they confirmed in their profile, and a
 * correct code opens the same "choose a new password" form a reset link does.
 *
 * Steps: email -> code -> choose account -> new password -> done. One
 * recovery email can serve several accounts; the list of them is shown only
 * after a correct code (proof of the inbox), and skipped when there's one.
 * The backend never says whether an address is a confirmed recovery email,
 * so step 2 is worded conditionally and a wrong address never gets a code.
 */
export default function RecoverAccountPage() {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [accounts, setAccounts] = useState<RecoveryAccount[]>([]);
  const [accountEmail, setAccountEmail] = useState("");

  /** Spends the code for one account and signs this browser into that
   * account's recovery session, which may set a password without the old one. */
  async function recover(userId: string, verifiedCode: string = code) {
    const { token_hash } = await verifyRecoveryCode(email.trim(), verifiedCode, userId);
    const { data, error } = await supabase.auth.verifyOtp({ token_hash, type: "recovery" });
    if (error || !data.user) throw error ?? new Error(t("Something went wrong."));
    setAccountEmail(data.user.email ?? "");
    setStep("password");
  }

  function startOver() {
    setCode("");
    setAccounts([]);
    setStep("email");
  }

  if (step === "done") return <DoneCard />;

  if (step === "password") {
    return <NewPasswordForm email={accountEmail} onDone={() => setStep("done")} />;
  }

  if (step === "choose") {
    return <ChooseStep accounts={accounts} onChoose={(userId) => recover(userId)} onStartOver={startOver} />;
  }

  if (step === "code") {
    return (
      <CodeStep
        email={email}
        onBack={startOver}
        onVerified={async (verifiedCode, found) => {
          setCode(verifiedCode);
          setAccounts(found);
          if (found.length === 1) {
            // Pass the code on directly: the `code` state set above isn't
            // visible until the next render.
            await recover(found[0].user_id, verifiedCode);
          } else {
            setStep("choose");
          }
        }}
      />
    );
  }

  return <EmailStep email={email} onEmailChange={setEmail} onSent={() => setStep("code")} />;
}

function EmailStep({
  email,
  onEmailChange,
  onSent,
}: {
  email: string;
  onEmailChange: (email: string) => void;
  onSent: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (sending) return;
    setError(null);
    setSending(true);
    try {
      await requestRecoveryCode(email.trim());
      onSent();
    } catch (err) {
      setError(requestErrorMessage(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="rounded-[var(--radius-card-lg)] border border-line bg-white p-7 shadow-[var(--shadow-card)] sm:p-8">
      <h1 className="text-h3 font-bold tracking-tight text-navy-900">{t("Recover your account")}</h1>
      <p className="mt-1.5 text-sm text-ink-500">
        {t("Can't get into your login email? Enter the recovery email you confirmed in your profile and we'll send it a 6-digit code.")}
      </p>

      {error && <ErrorBanner message={error} />}

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-ink-700">{t("Recovery email")}</span>
          <div className="relative">
            <Envelope size={17} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-300" />
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => onEmailChange(e.target.value)}
              placeholder="you@backup-email.com"
              className="w-full rounded-[var(--radius-control)] border border-line bg-white py-2.5 pl-10 pr-4 text-sm placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </div>
        </label>
        <Button type="submit" size="lg" loading={sending} fullWidth className="mt-1">
          {t("Send code")}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-ink-600">
        {t("Can access your login email?")}{" "}
        <Link to="/forgot-password" className="font-semibold text-brand-600 hover:underline">
          {t("Reset by email instead")}
        </Link>
      </p>
    </div>
  );
}

function CodeStep({
  email,
  onBack,
  onVerified,
}: {
  email: string;
  onBack: () => void;
  onVerified: (code: string, accounts: RecoveryAccount[]) => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  async function handleVerify(e: FormEvent) {
    e.preventDefault();
    if (code.length !== 6 || inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setVerifying(true);
    try {
      const { accounts } = await verifyRecoveryCode(email.trim(), code);
      await onVerified(code, accounts);
    } catch (err) {
      setCode("");
      setError(verifyErrorMessage(err));
    } finally {
      inFlight.current = false;
      setVerifying(false);
    }
  }

  async function resend() {
    setError(null);
    setResent(false);
    setResending(true);
    try {
      await requestRecoveryCode(email.trim());
      setResent(true);
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      setError(requestErrorMessage(err));
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="rounded-[var(--radius-card-lg)] border border-line bg-white p-7 shadow-[var(--shadow-card)] sm:p-8">
      <h1 className="text-h3 font-bold tracking-tight text-navy-900">{t("Enter your code")}</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-500">
        {t("If {{email}} is a confirmed recovery email, we've sent it a 6-digit code. It expires in 30 minutes.", {
          email: email.trim(),
        })}
      </p>

      {error && <ErrorBanner message={error} />}
      {resent && !error && <p className="mt-4 text-sm text-green-700">{t("We sent a new code. Use the latest one.")}</p>}

      <form onSubmit={handleVerify} className="mt-6 flex flex-col gap-3">
        <CodeInput value={code} onChange={setCode} autoFocus />
        <Button type="submit" size="lg" fullWidth loading={verifying} disabled={code.length !== 6}>
          {t("Continue")}
        </Button>
      </form>

      <div className="mt-4 flex flex-col items-center gap-2 text-sm">
        <button
          type="button"
          onClick={resend}
          disabled={cooldown > 0 || resending}
          className="font-semibold text-brand-600 hover:underline disabled:cursor-not-allowed disabled:text-ink-400 disabled:no-underline"
        >
          {cooldown > 0 ? t("Send a new code in {{seconds}}s", { seconds: cooldown }) : t("Send a new code")}
        </button>
        <button type="button" onClick={onBack} className="font-semibold text-ink-600 hover:underline">
          {t("Use a different email")}
        </button>
      </div>
    </div>
  );
}

function ChooseStep({
  accounts,
  onChoose,
  onStartOver,
}: {
  accounts: RecoveryAccount[];
  onChoose: (userId: string) => Promise<void>;
  onStartOver: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function handleContinue() {
    if (!selected || inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setWorking(true);
    try {
      await onChoose(selected);
    } catch (err) {
      setError(verifyErrorMessage(err));
    } finally {
      inFlight.current = false;
      setWorking(false);
    }
  }

  return (
    <div className="rounded-[var(--radius-card-lg)] border border-line bg-white p-7 shadow-[var(--shadow-card)] sm:p-8">
      <h1 className="text-h3 font-bold tracking-tight text-navy-900">{t("Choose an account")}</h1>
      <p className="mt-1.5 text-sm text-ink-500">
        {t("This recovery email is linked to {{count}} accounts. Which one do you want to recover?", {
          count: accounts.length,
        })}
      </p>

      {error && <ErrorBanner message={error} />}

      <div role="radiogroup" aria-label={t("Accounts")} className="mt-5 flex flex-col gap-2.5">
        {accounts.map((account) => {
          const active = selected === account.user_id;
          return (
            <button
              key={account.user_id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setSelected(account.user_id)}
              className={`flex items-center gap-3 rounded-[var(--radius-control)] border px-4 py-3 text-left transition-colors ${
                active ? "border-brand-500 bg-brand-100/50 ring-2 ring-brand-200" : "border-line hover:border-brand-300 hover:bg-surface-muted"
              }`}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-navy-900 text-xs font-bold text-white">
                {initials(account)}
              </span>
              <span className="min-w-0">
                {account.name && <span className="block truncate text-sm font-semibold text-ink-900">{account.name}</span>}
                <span className={`block truncate text-sm ${account.name ? "text-ink-500" : "font-semibold text-ink-900"}`}>
                  {account.email}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <Button size="lg" fullWidth className="mt-5" loading={working} disabled={!selected} onClick={handleContinue}>
        {t("Continue")}
      </Button>
      <div className="mt-4 text-center text-sm">
        <button type="button" onClick={onStartOver} className="font-semibold text-ink-600 hover:underline">
          {t("Start over")}
        </button>
      </div>
    </div>
  );
}

function initials(account: RecoveryAccount): string {
  const source = account.name || account.email.split("@")[0] || "?";
  const parts = source.trim().split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : source.slice(0, 2)).toUpperCase();
}

function verifyErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 400) {
    return t("That code is wrong or has expired. Check the latest email, or send a new code.");
  }
  if (err instanceof ApiError && err.status === 429) return t("Too many attempts. Please wait a while and try again.");
  return err instanceof Error ? err.message : t("Something went wrong.");
}

function DoneCard() {
  const navigate = useNavigate();
  return (
    <AuthResultCard
      tone="success"
      title={t("Password updated")}
      actions={
        <Button size="lg" fullWidth onClick={() => navigate("/login", { replace: true })}>
          {t("Back to Login")}
        </Button>
      }
    >
      {t("Your password has been changed and you've been signed out everywhere. Log in with your new password.")}
    </AuthResultCard>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="mt-5 flex items-start gap-2.5 rounded-[var(--radius-control)] border border-severity-high-line bg-severity-high-bg px-4 py-3 text-sm text-severity-high">
      <WarningCircle size={18} weight="fill" className="mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

function requestErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 429) return t("Too many requests. Please wait a minute and try again.");
  if (err instanceof ApiError) return t("We couldn't send the code right now. Try again in a few minutes.");
  return t("We couldn't reach Etymos. Check your connection and try again.");
}
