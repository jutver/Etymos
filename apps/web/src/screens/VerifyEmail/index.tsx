import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { EnvelopeSimple, ArrowClockwise, CheckCircle } from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";
import { supabase } from "@etymos/shared";

interface LocationState {
  email?: string;
}

export default function VerifyEmailPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const email = (location.state as LocationState)?.email ?? "";

  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);

  async function handleVerify(e: FormEvent) {
    e.preventDefault();
    if (!email || code.length < 6) return;

    setVerifying(true);
    setError(null);

    const { error: verifyError } = await supabase.auth.verifyOtp({
      email,
      token: code,
      type: "signup",
    });

    setVerifying(false);
    if (verifyError) {
      setError(verifyError.message);
      return;
    }
    navigate("/upload", { replace: true });
  }

  async function handleResend() {
    if (!email) return;
    setResending(true);
    setError(null);
    setResent(false);

    const { error: resendError } = await supabase.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: `${window.location.origin}/email-verified` },
    });

    setResending(false);
    if (resendError) {
      setError(resendError.message);
      return;
    }
    setResent(true);
  }

  return (
    <div className="rounded-[var(--radius-card-lg)] border border-line bg-white p-7 shadow-[var(--shadow-card)] sm:p-8">
      <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-brand-100 text-brand-600">
        <EnvelopeSimple size={28} weight="fill" />
      </div>

      <h1 className="mt-5 text-center text-h3 font-bold tracking-tight text-navy-900">
        Check your email
      </h1>

      <p className="mt-2.5 text-center text-sm leading-relaxed text-ink-600">
        We've sent a 6-digit verification code to{" "}
        {email ? (
          <span className="font-semibold text-navy-900">{email}</span>
        ) : (
          "your email address"
        )}
        . Enter it below to activate your account.
      </p>

      <form onSubmit={handleVerify} className="mt-6 flex flex-col gap-3">
        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          placeholder="123456"
          className="w-full rounded-[var(--radius-control)] border border-line bg-white py-2.5 px-4 text-center text-lg font-semibold tracking-[0.4em] placeholder:tracking-normal placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
        />

        {error && <p className="text-center text-sm text-severity-high">{error}</p>}

        {resent && (
          <div className="flex items-center justify-center gap-2 text-sm text-green-600">
            <CheckCircle size={16} weight="fill" />
            <span>Verification code resent!</span>
          </div>
        )}

        <Button type="submit" size="lg" fullWidth loading={verifying} disabled={!email || code.length < 6}>
          Verify email
        </Button>
      </form>

      <Button
        variant="outline"
        size="lg"
        fullWidth
        loading={resending}
        onClick={handleResend}
        disabled={!email}
        className="mt-3"
        iconLeft={<ArrowClockwise size={16} />}
      >
        Resend code
      </Button>

      <p className="mt-6 text-center text-sm text-ink-600">
        Already verified?{" "}
        <Link to="/login" className="font-semibold text-brand-600 hover:underline">
          Log in
        </Link>
      </p>
    </div>
  );
}
