import { useEffect, type ReactNode } from "react";
import { X } from "@phosphor-icons/react";
import type { ReferralResponse } from "../../lib/referralQueries";
import { currentLocale, t } from "../../lib/i18n";

interface ResponseDialogProps {
  response: ReferralResponse;
  /** The source cell as the table shows it (colored dot + label). */
  source: ReactNode;
  onClose: () => void;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-caption font-medium text-fg-muted">{label}</dt>
      <dd className="mt-1 text-body text-fg">{children}</dd>
    </div>
  );
}

/** One survey response in full — the table cuts long "Other" text to a line. */
export function ResponseDialog({ response, source, onClose }: ResponseDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("Survey response")}
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-card border border-border bg-surface shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <p className="text-body font-medium text-fg">{t("Survey response")}</p>
          <button
            type="button"
            onClick={onClose}
            title={t("Close")}
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-control text-fg-muted transition hover:bg-surface-raised active:scale-95"
          >
            <X size={16} weight="bold" />
          </button>
        </div>

        <dl className="flex flex-col gap-4 overflow-y-auto p-5">
          <Field label={t("When")}>
            {new Date(response.created_at).toLocaleString(currentLocale(), { dateStyle: "full", timeStyle: "medium" })}
          </Field>
          <Field label={t("Who")}>
            {response.user?.email ?? <span className="text-fg-subtle">{t("Deleted account")}</span>}
          </Field>
          <Field label={t("Source")}>{source}</Field>
          <Field label={t("Details")}>
            {response.other_text ? (
              <p className="whitespace-pre-wrap break-words rounded-control border border-border bg-surface-muted px-3 py-2">
                {response.other_text}
              </p>
            ) : (
              <span className="text-fg-subtle">—</span>
            )}
          </Field>
        </dl>
      </div>
    </div>
  );
}
