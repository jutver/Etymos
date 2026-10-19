import { useEffect, useState } from "react";
import { Plus, X } from "@phosphor-icons/react";
import { searchProfileEmails } from "../lib/configQueries";
import { t as tl } from "../lib/i18n";

const INPUT =
  "w-full rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent";
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function parseEmails(raw: string): { valid: string[]; invalid: string[] } {
  const parts = raw.split(/[\s,;]+/).map((p) => p.trim().toLowerCase()).filter(Boolean);
  return { valid: parts.filter((p) => EMAIL_RE.test(p)), invalid: parts.filter((p) => !EMAIL_RE.test(p)) };
}

/** A list of emails: type or paste them, or find an account by email or name.
 * Used for discount audiences and maintenance bypass lists. */
export function EmailPicker({ emails, onChange }: { emails: string[]; onChange: (emails: string[]) => void }) {
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState<string[]>([]);
  const [matches, setMatches] = useState<{ email: string; display_name: string | null }[]>([]);

  useEffect(() => {
    const term = text.trim();
    if (term.length < 2 || /[\s,;]/.test(term)) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchProfileEmails(term)
        .then((rows) => !cancelled && setMatches(rows.filter((r) => !emails.includes(r.email.toLowerCase()))))
        .catch(() => !cancelled && setMatches([]));
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [text, emails]);

  function add(raw: string) {
    const parsed = parseEmails(raw);
    if (parsed.valid.length) onChange([...new Set([...emails, ...parsed.valid])]);
    setInvalid(parsed.invalid);
    setText(parsed.invalid.join(", "));
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <div className="flex gap-2">
          <input
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setInvalid([]);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                add(text);
              }
            }}
            onPaste={(e) => {
              const pasted = e.clipboardData.getData("text");
              if (/[\s,;]/.test(pasted.trim())) {
                e.preventDefault();
                add(`${text} ${pasted}`);
              }
            }}
            placeholder={tl("Type an email or name, or paste a list")}
            className={INPUT}
          />
          <button
            type="button"
            onClick={() => add(text)}
            disabled={!text.trim()}
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-control border border-border px-3 text-caption font-medium text-fg-muted transition hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus size={14} weight="bold" />
            {tl("Add")}
          </button>
        </div>
        {matches.length > 0 && (
          <ul className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-control border border-border bg-surface shadow-pop">
            {matches.map((m) => (
              <li key={m.email}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange([...emails, m.email.toLowerCase()]);
                    setText("");
                  }}
                  className="flex w-full cursor-pointer items-baseline gap-2 px-3 py-2 text-left hover:bg-surface-raised"
                >
                  <span className="truncate text-body text-fg">{m.email}</span>
                  {m.display_name && <span className="truncate text-caption text-fg-subtle">{m.display_name}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {invalid.length > 0 && (
        <p className="text-caption text-destructive">{tl("Not an email: {{list}}", { list: invalid.join(", ") })}</p>
      )}
      {emails.length > 0 && (
        <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
          {emails.map((email) => (
            <span
              key={email}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-raised py-0.5 pl-2.5 pr-1 text-caption text-fg"
            >
              {email}
              <button
                type="button"
                onClick={() => onChange(emails.filter((e) => e !== email))}
                aria-label={tl("Remove {{email}}", { email })}
                className="flex size-4 cursor-pointer items-center justify-center rounded-full text-fg-subtle hover:bg-surface hover:text-fg"
              >
                <X size={10} weight="bold" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between text-caption text-fg-subtle">
        <span>{tl("{{count}} email(s)", { count: emails.length })}</span>
        {emails.length > 1 && (
          <button type="button" onClick={() => onChange([])} className="cursor-pointer hover:text-fg">
            {tl("Clear all")}
          </button>
        )}
      </div>
    </div>
  );
}
