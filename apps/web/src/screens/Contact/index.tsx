import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { CheckCircle, EnvelopeSimple, WarningCircle } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { Button } from "../../components/ui/Button";
import { AttachmentPicker } from "../../components/support/AttachmentPicker";
import { CATEGORY_LABELS, SUPPORT_EMAIL, supportErrorText } from "../../components/support/labels";
import { openSupportTicket, type SupportCategory } from "../../lib/api";
import { displayNameFor, useAuth } from "../../lib/auth";
import { t } from "../../lib/i18n";

const CATEGORIES = Object.keys(CATEGORY_LABELS) as SupportCategory[];

const field =
  "w-full rounded-[var(--radius-control)] border border-line bg-white px-3.5 py-2.5 text-sm placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200 disabled:bg-surface-tint disabled:text-ink-500";

/**
 * Contact support. Works signed in (the request is tied to the account and
 * shows up under My requests) and signed out (we answer by email, and the
 * email links to the conversation) — someone locked out of their account
 * must still be able to reach us.
 */
export default function ContactPage() {
  const { user } = useAuth();
  const [category, setCategory] = useState<SupportCategory | "">("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ number: number; signedIn: boolean; email: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (sending) return;
    if (!category) {
      setError(t("Choose a topic."));
      return;
    }
    setSending(true);
    setError(null);
    try {
      const result = await openSupportTicket({
        category,
        subject: subject.trim(),
        body: body.trim(),
        email: user ? undefined : email.trim(),
        name: user ? displayNameFor(user) : name.trim() || undefined,
        website: website || undefined,
        files,
      });
      setSent({ number: result.number, signedIn: result.signed_in, email: user?.email ?? email.trim() });
    } catch (err) {
      setError(supportErrorText(err));
    } finally {
      setSending(false);
    }
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
            {sent.signedIn ? (
              <Button as="link" to={`/account/support/${sent.number}`}>
                {t("View your request")}
              </Button>
            ) : (
              <Button as="link" to="/">
                {t("Back to Etymos")}
              </Button>
            )}
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
        {user && (
          <p className="mt-4 text-sm text-ink-500">
            <Link to="/account/support" className="font-semibold text-brand-600 underline underline-offset-2">
              {t("See your previous requests")}
            </Link>
          </p>
        )}
      </div>

      <form
        onSubmit={submit}
        className="studio-card flex flex-col gap-5 rounded-[var(--radius-card-lg)] border border-line bg-white p-6 shadow-[var(--shadow-card)] sm:p-8"
      >
        {user ? (
          <p className="rounded-[var(--radius-control)] bg-surface-tint px-3.5 py-2.5 text-sm text-ink-600">
            {t("Signed in as {{email}}. We'll reply to this address.", { email: user.email ?? "" })}
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-ink-700">{t("Your email")}</span>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className={field} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-ink-700">
                {t("Your name")} <span className="font-normal text-ink-400">{t("(optional)")}</span>
              </span>
              <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} className={field} />
            </label>
          </div>
        )}

        <fieldset>
          <legend className="mb-2 text-xs font-semibold text-ink-700">{t("Topic")}</legend>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={category === c}
                onClick={() => setCategory(c)}
                className={cn(
                  "rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors",
                  category === c
                    ? "border-brand-500 bg-brand-100/60 text-brand-700"
                    : "border-line bg-white text-ink-600 hover:border-brand-300",
                )}
              >
                {t(CATEGORY_LABELS[c])}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-ink-700">{t("Subject")}</span>
          <input required maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t("A short summary")} className={field} />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-ink-700">{t("Message")}</span>
          <textarea
            required
            rows={7}
            maxLength={10000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t("What happened, what you expected, and any order or report details that help us find it.")}
            className={cn(field, "resize-y")}
          />
        </label>

        {/* Honeypot: hidden from people, filled in by bots. */}
        <input
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          className="absolute -left-[9999px] h-0 w-0 opacity-0"
        />

        <AttachmentPicker files={files} onChange={setFiles} onError={setError} />

        {error && (
          <p className="flex items-start gap-2 rounded-[var(--radius-control)] border border-severity-high-line bg-severity-high-bg px-3.5 py-2.5 text-sm text-severity-high">
            <WarningCircle size={18} weight="fill" className="mt-0.5 shrink-0" />
            {error}
          </p>
        )}

        <Button type="submit" size="lg" loading={sending} fullWidth>
          {t("Send request")}
        </Button>
      </form>
    </div>
  );
}
