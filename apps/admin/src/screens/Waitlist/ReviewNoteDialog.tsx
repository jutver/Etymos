import { useState } from "react";
import { X } from "@phosphor-icons/react";
import { t } from "../../lib/i18n";

interface ReviewNoteDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  pending?: boolean;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}

/** Shared reason prompt for the two negative Waitlist actions (reject access,
 * decline purchase) — both persist an optional free-text note alongside the
 * reviewer id so the decision is auditable.
 *
 * This note is NOT internal. `access_note` is rendered verbatim to the
 * rejected user on the web app's /waitlist screen, so the field is labelled
 * as user-visible here — an admin must not be able to write private triage
 * commentary into it by mistake. */
export function ReviewNoteDialog({
  title,
  description,
  confirmLabel,
  pending,
  onCancel,
  onConfirm,
}: ReviewNoteDialogProps) {
  const [note, setNote] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onCancel}>
      <div
        className="w-full max-w-md overflow-hidden rounded-card border border-border bg-surface shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <p className="text-body font-medium text-fg">{t(title)}</p>
          <button
            type="button"
            onClick={onCancel}
            title={t("Close")}
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-control text-fg-muted transition hover:bg-surface-raised active:scale-95"
          >
            <X size={16} weight="bold" />
          </button>
        </div>

        <div className="p-5">
          <p className="text-caption text-fg-muted">{t(description)}</p>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder={t("Reason (optional)…")}
            className="mt-3 w-full resize-none rounded-control border border-border bg-surface-muted px-3 py-2 text-body text-fg outline-none focus-visible:border-accent"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="cursor-pointer rounded-control border border-border px-3 py-1.5 text-caption font-medium text-fg-muted transition hover:bg-surface-raised active:scale-95"
            >
              {t("Cancel")}</button>
            <button
              type="button"
              disabled={pending}
              onClick={() => onConfirm(note)}
              className="cursor-pointer rounded-control border border-destructive/40 bg-destructive-bg px-3 py-1.5 text-caption font-medium text-destructive transition hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t(confirmLabel)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
