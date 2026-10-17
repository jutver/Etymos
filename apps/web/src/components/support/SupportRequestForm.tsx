import { useState, type FormEvent } from "react";
import { WarningCircle } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { Button } from "../ui/Button";
import { AttachmentPicker } from "./AttachmentPicker";
import { CATEGORY_LABELS, supportErrorText } from "./labels";
import { openSupportTicket, type SupportCategory } from "../../lib/api";
import { displayNameFor, useAuth } from "../../lib/auth";
import { t } from "../../lib/i18n";

const CATEGORIES = Object.keys(CATEGORY_LABELS) as SupportCategory[];

const field =
  "w-full rounded-[var(--radius-control)] border border-line bg-white px-3.5 py-2.5 text-sm placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200 disabled:bg-surface-tint disabled:text-ink-500";

export interface SupportRequestSent {
  number: number;
  signedIn: boolean;
  /** Where the confirmation email went. */
  email: string;
}

/**
 * The new-request form, shared by /contact (signed out, or signed in but
 * kept out of the app) and /account/support/new. Signed in, the request is
 * tied to the account; signed out, it asks for an email to reply to.
 */
export function SupportRequestForm({ onSent, className }: { onSent: (sent: SupportRequestSent) => void; className?: string }) {
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
      onSent({ number: result.number, signedIn: result.signed_in, email: user?.email ?? email.trim() });
    } catch (err) {
      setError(supportErrorText(err));
      setSending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className={cn(
        "studio-card flex flex-col gap-5 rounded-[var(--radius-card-lg)] border border-line bg-white p-6 shadow-[var(--shadow-card)] sm:p-8",
        className,
      )}
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
  );
}
