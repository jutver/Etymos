import { useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { ArrowRight, ChatCircleText, CheckCircle, Clock, EnvelopeSimple, Question } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import { Button } from "../../components/ui/Button";
import { PageLoader } from "../../components/ui/PageLoader";
import { SUPPORT_EMAIL } from "../../components/support/labels";
import { SupportRequestForm, type SupportRequestSent } from "../../components/support/SupportRequestForm";
import { useAuth } from "../../lib/auth";
import { fetchFeatureFlag } from "../../lib/featureFlags";
import { fetchMyProfile } from "../../lib/profileQueries";
import { t } from "../../lib/i18n";
import { SOCIAL_LINKS } from "../../lib/social";
import { Highlight, PageHero } from "../../components/marketing/Marketing";
import { useSmoothPage, useStaggerIn } from "../../lib/useSmoothPage";

/**
 * Contact support, for people who aren't signed in (we answer by email, and
 * the email links to the conversation). Signed-in users who can use the app
 * are sent to /account/support/new instead. Signed-in users kept out of it
 * (waitlist, pending deletion) stay here, since the account pages would only
 * show them the gate again.
 */
export default function ContactPage() {
  const { user, loading } = useAuth();
  // Signed-out visitors are known not to be in the app straight away, so they
  // don't see a loader flash before the page.
  const [inApp, setInApp] = useState<boolean | null>(() => (!loading && !user ? false : null));
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

  return <ContactContent emailWelcome={emailWelcome} onSent={setSent} />;
}

/**
 * The page itself, mounted only once the gate above has decided, so its
 * entrance plays when it actually appears: the header rises in, then the
 * contact cards and the form follow one after another.
 */
function ContactContent({ emailWelcome, onSent }: { emailWelcome: boolean; onSent: (sent: SupportRequestSent) => void }) {
  const root = useRef<HTMLDivElement>(null);
  useSmoothPage(root);
  useStaggerIn(root, ".mk-contact-list > *, .mk-contact-form", true);

  return (
    <div ref={root} className="mk-page">
      <PageHero
        chip={t("Contact")}
        title={<>{t("Talk to the")} <Highlight>{t("Etymos team")}</Highlight></>}
        lead={t("Tell us what's going on and we'll get back to you by email, usually within one business day.")}
      />

      <div className="mx-auto grid max-w-6xl gap-8 px-5 py-16 sm:px-8 lg:grid-cols-[1fr_1.6fr] lg:py-20">
        <aside className="mk-contact-list space-y-3">
          <h2 className="text-h3 font-bold tracking-tight text-navy-900">{t("How can we help?")}</h2>
          <p className="text-sm leading-relaxed text-ink-500">
            {t("Questions about your account, a payment or a report all go to the same team.")}
          </p>

          {emailWelcome && (
            <a href={`mailto:${SUPPORT_EMAIL}`} className="mk-card mk-card-hover flex items-center gap-3.5 p-4">
              <span className="mk-icon shrink-0"><EnvelopeSimple size={20} weight="bold" aria-hidden="true" /></span>
              <span className="min-w-0">
                <span className="block text-[0.6875rem] font-bold uppercase tracking-wide text-ink-500">{t("Email")}</span>
                <span className="block truncate text-sm font-semibold text-navy-900">{SUPPORT_EMAIL}</span>
              </span>
            </a>
          )}

          {SOCIAL_LINKS.map(({ name, label, href, Icon }) => (
            <a key={href} href={href} target="_blank" rel="noopener noreferrer" className="mk-card mk-card-hover flex items-center gap-3.5 p-4">
              <span className="mk-icon shrink-0"><Icon size={20} weight="fill" aria-hidden="true" /></span>
              <span className="min-w-0">
                <span className="block text-[0.6875rem] font-bold uppercase tracking-wide text-ink-500">{name}</span>
                <span className="block truncate text-sm font-semibold text-navy-900">{label()}</span>
              </span>
            </a>
          ))}

          <div className="mk-card flex items-center gap-3.5 p-4">
            <span className="mk-icon shrink-0"><Clock size={20} weight="bold" aria-hidden="true" /></span>
            <span>
              <span className="block text-[0.6875rem] font-bold uppercase tracking-wide text-ink-500">{t("Reply time")}</span>
              <span className="block text-sm font-semibold text-navy-900">{t("Usually within one business day")}</span>
            </span>
          </div>

          <Link to="/pricing" className="mk-card mk-card-hover flex items-center gap-3.5 p-4">
            <span className="mk-icon shrink-0"><Question size={20} weight="bold" aria-hidden="true" /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-[0.6875rem] font-bold uppercase tracking-wide text-ink-500">{t("Plans and payments")}</span>
              <span className="block text-sm font-semibold text-navy-900">{t("Read the pricing FAQ")}</span>
            </span>
            <ArrowRight size={16} className="text-ink-400" aria-hidden="true" />
          </Link>
        </aside>

        <section className="mk-contact-form">
          <div className="mb-4 flex items-center gap-3">
            <span className="mk-icon shrink-0"><ChatCircleText size={20} weight="bold" aria-hidden="true" /></span>
            <div>
              <h2 className="text-lg font-bold tracking-tight text-navy-900">{t("Send us a message")}</h2>
              <p className="text-xs text-ink-500">{t("We'll reply to the email address you give below.")}</p>
            </div>
          </div>
          <SupportRequestForm onSent={onSent} />
        </section>
      </div>
    </div>
  );
}
