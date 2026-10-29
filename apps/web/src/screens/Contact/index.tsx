import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { CheckCircle, EnvelopeSimple } from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";
import { PageLoader } from "../../components/ui/PageLoader";
import { SUPPORT_EMAIL } from "../../components/support/labels";
import { SupportRequestForm, type SupportRequestSent } from "../../components/support/SupportRequestForm";
import { useAuth } from "../../lib/auth";
import { fetchFeatureFlag } from "../../lib/featureFlags";
import { fetchMyProfile } from "../../lib/profileQueries";
import { t } from "../../lib/i18n";

/**
 * Contact support, for people who aren't signed in (we answer by email, and
 * the email links to the conversation). Signed-in users who can use the app
 * are sent to /account/support/new instead. Signed-in users kept out of it
 * (waitlist, pending deletion) stay here, since the account pages would only
 * show them the gate again.
 */
export default function ContactPage() {
  const { user, loading } = useAuth();
  const [inApp, setInApp] = useState<boolean | null>(null);
  const [sent, setSent] = useState<SupportRequestSent | null>(null);
  // The admin's "requests by email" switch; the address is only offered while it's on.
  const [emailWelcome, setEmailWelcome] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchFeatureFlag("support_email_requests", true)
      .then((on) => !cancelled && setEmailWelcome(on))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!user) {
      setInApp(false);
      return;
    }
    let cancelled = false;
    setInApp(null);
    fetchMyProfile(user.id)
      .then((p) => {
        if (cancelled) return;
        const allowed = p.role === "admin" || p.accessStatus === "approved";
        setInApp(allowed && !p.isBanned && !p.deletionRequestedAt);
      })
      .catch(() => !cancelled && setInApp(false));
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  if (!sent) {
    if (loading || inApp === null) return <PageLoader />;
    if (inApp) return <Navigate to="/account/support/new" replace />;
  }

  if (sent) {
    return (
      <div className="mx-auto max-w-xl px-5 py-16 sm:px-8 sm:py-24">
        <div className="studio-card rounded-[var(--radius-card-lg)] border border-line bg-white p-7 text-center shadow-[var(--shadow-card)] sm:p-9">
          <CheckCircle size={40} weight="fill" className="mx-auto text-success" />
          <h1 className="mt-4 text-h2 font-bold tracking-tight text-navy-900">
            {t("Request #{{number}} received", { number: sent.number })}
          </h1>
          <p className="mt-2 text-sm text-ink-500">
            {t("We've emailed a confirmation to {{email}}. Our team usually replies within one business day; just reply to our email to add anything.", { email: sent.email })}
          </p>
          <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
            <Button as="link" to="/">
              {t("Back to Etymos")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto grid max-w-5xl gap-10 px-5 py-14 sm:px-8 sm:py-20 lg:grid-cols-[1fr_1.6fr]">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-brand-600">{t("Support")}</p>
        <h1 className="mt-2 text-h1 font-bold tracking-tight text-navy-900">{t("How can we help?")}</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-500">
          {t("Tell us what's going on and we'll get back to you by email, usually within one business day.")}
        </p>
        {emailWelcome && (
          <div className="mt-6 flex items-start gap-3 rounded-[var(--radius-card)] border border-line bg-surface-tint px-4 py-3.5 text-sm text-ink-600">
            <EnvelopeSimple size={18} className="mt-0.5 shrink-0 text-brand-600" />
            <p>
              {t("Prefer email? Write to")}{" "}
              <a href={`mailto:${SUPPORT_EMAIL}`} className="font-semibold text-brand-600 underline underline-offset-2">
                {SUPPORT_EMAIL}
              </a>
              .
            </p>
          </div>
        )}
      </div>

      <SupportRequestForm onSent={setSent} />
    </div>
  );
}
