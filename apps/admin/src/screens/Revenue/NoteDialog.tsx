import { useState, type ReactNode } from "react";
import { X } from "@phosphor-icons/react";
import { t } from "../../lib/i18n";

interface NoteDialogProps {
  title: string;
  description: ReactNode;
  placeholder: string;
  confirmLabel: string;
  /** Disable confirm until something is typed. */
  required?: boolean;
  pending?: boolean;
  /** Extra content between the description and the note (e.g. an order lookup). */
  children?: ReactNode;
  confirmDisabled?: boolean;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}

/** Modal with an internal note for the payment ledger. Notes here are only
 * ever shown to admins. */
export function NoteDialog({
  title,
  description,
  placeholder,
  confirmLabel,
  required = false,
  pending = false,
  children,
  confirmDisabled = false,
  onCancel,
  onConfirm,
}: NoteDialogProps) {
  const [note, setNote] = useState("");
  const blocked = pending || confirmDisabled || (required && !note.trim());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-md overflow-hidden rounded-card border border-border bg-surface shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <p className="text-body font-medium text-fg">{title}</p>
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
          <div className="text-caption text-fg-muted">{description}</div>
          {children}
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder={placeholder}
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
              disabled={blocked}
              onClick={() => onConfirm(note)}
              className="cursor-pointer rounded-control border border-accent/40 bg-accent-bg px-3 py-1.5 text-caption font-medium text-accent transition hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
