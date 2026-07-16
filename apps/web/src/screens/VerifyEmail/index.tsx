import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { EnvelopeSimple, ArrowClockwise, CheckCircle } from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";
import { supabase } from "@etymos/shared";

interface LocationState {
  email?: string;
}

export default function VerifyEmailPage() {
  const location = useLocation();
  const email = (location.state as LocationState)?.email ?? "";

  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleResend() {
    if (!email) return;
    setResending(true);
    setError(null);
    setResent(false);

    const { error: resendError } = await supabase.auth.resend({
      type: "signup",
      email,
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
        We've sent a verification link to{" "}
        {email ? (
          <span className="font-semibold text-navy-900">{email}</span>
        ) : (
          "your email address"
        )}
        . Click the link to activate your account.
      </p>

      {error && (
        <p className="mt-4 text-center text-sm text-severity-high">{error}</p>
      )}

      {resent && (
        <div className="mt-4 flex items-center justify-center gap-2 text-sm text-green-600">
          <CheckCircle size={16} weight="fill" />
          <span>Verification email resent!</span>
        </div>
      )}

      <Button
        variant="outline"
        size="lg"
        fullWidth
        loading={resending}
        onClick={handleResend}
        disabled={!email}
        className="mt-6"
        iconLeft={<ArrowClockwise size={16} />}
      >
        Resend verification email
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
