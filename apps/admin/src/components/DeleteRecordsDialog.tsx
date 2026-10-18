import { useState } from "react";
import { X } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import type { DeleteScope } from "../lib/storageFiles";
import { t } from "../lib/i18n";

const CONFIRM_PHRASE = "DELETE";

interface DeleteRecordsDialogProps {
  title: string;
  /** Rows picked in the table; the "selected" choice is off without any. */
  selectedIds: string[];
  /** Status choices, labels already wrapped in tr(). Leave out to confirm
   * deleting just `selectedIds`, with `description` saying what that is. */
  statuses?: { key: string; label: string }[];
  description?: string;
  /** The status preselected for "every … with status". */
  defaultStatus?: string;
  pending?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (scope: DeleteScope) => void;
}

/** Picks what to delete — the selected rows, every row with one status, or
 * everything — and confirms it. Deleting by status or everything needs the
 * confirm phrase typed, since it can reach rows that aren't on screen. */
export function DeleteRecordsDialog({
  title,
  selectedIds,
  statuses = [],
  description,
  defaultStatus,
  pending,
  error,
  onCancel,
  onConfirm,
}: DeleteRecordsDialogProps) {
  const [kind, setKind] = useState<DeleteScope["kind"]>(selectedIds.length > 0 ? "ids" : "status");
  const [status, setStatus] = useState(defaultStatus ?? statuses[0]?.key ?? "");
  const [phrase, setPhrase] = useState("");
  const needsPhrase = kind !== "ids";
  const ready = !pending && (!needsPhrase || phrase.trim() === CONFIRM_PHRASE);

  function confirm() {
    if (!ready) return;
    if (kind === "ids") onConfirm({ kind, ids: selectedIds });
    else if (kind === "status") onConfirm({ kind, status });
    else onConfirm({ kind: "all" });
  }

  const option = (value: DeleteScope["kind"], disabled = false) =>
    cn(
      "flex cursor-pointer items-start gap-2.5 rounded-control border px-3 py-2.5 text-body transition-colors",
      kind === value ? "border-destructive/50 bg-destructive-bg/50" : "border-border hover:bg-surface-raised",
      disabled && "cursor-not-allowed opacity-50",
    );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
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

        <div className="flex flex-col gap-2 p-5">
          {description && <p className="text-body text-fg">{description}</p>}
          {statuses.length > 0 && (
            <>
              <label className={option("ids", selectedIds.length === 0)}>
                <input
                  type="radio"
                  name="delete-scope"
                  checked={kind === "ids"}
                  disabled={selectedIds.length === 0}
                  onChange={() => setKind("ids")}
                  className="mt-1 accent-destructive"
                />
                <span className="text-fg">
                  {selectedIds.length > 0
                    ? t("The {{count}} selected", { count: selectedIds.length })
                    : t("Selected rows (pick some in the table first)")}
                </span>
              </label>

              <label className={option("status")}>
                <input
                  type="radio"
                  name="delete-scope"
                  checked={kind === "status"}
                  onChange={() => setKind("status")}
                  className="mt-1 accent-destructive"
                />
                <span className="flex flex-1 flex-wrap items-center gap-2 text-fg">
                  {t("Every one with status")}
                  <select
                    value={status}
                    onChange={(e) => {
                      setStatus(e.target.value);
                      setKind("status");
                    }}
                    className="rounded-control border border-border bg-surface-muted px-2 py-1 text-body text-fg outline-none focus-visible:border-accent"
                  >
                    {statuses.map((s) => (
                      <option key={s.key} value={s.key}>
                        {t(s.label)}
                      </option>
                    ))}
                  </select>
                </span>
              </label>

              <label className={option("all")}>
                <input
                  type="radio"
                  name="delete-scope"
                  checked={kind === "all"}
                  onChange={() => setKind("all")}
                  className="mt-1 accent-destructive"
                />
                <span className="text-fg">{t("Everything, whatever the status")}</span>
              </label>
            </>
          )}

          <p className="mt-2 text-caption text-fg-muted">
            {t("The records and their files are deleted permanently. This can't be undone.")}
          </p>

          {needsPhrase && (
            <label className="mt-1 flex flex-col gap-1 text-caption text-fg-muted">
              {t("Type {{phrase}} to confirm", { phrase: CONFIRM_PHRASE })}
              <input
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && confirm()}
                autoComplete="off"
                className="rounded-control border border-border bg-surface-muted px-3 py-2 font-mono text-body text-fg outline-none focus-visible:border-destructive"
              />
            </label>
          )}

          {error && <p className="text-caption text-destructive">{error}</p>}

          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="cursor-pointer rounded-control border border-border px-3 py-1.5 text-caption font-medium text-fg-muted transition hover:bg-surface-raised active:scale-95"
            >
              {t("Cancel")}
            </button>
            <button
              type="button"
              disabled={!ready}
              onClick={confirm}
              className="cursor-pointer rounded-control border border-destructive/40 bg-destructive-bg px-3 py-1.5 text-caption font-medium text-destructive transition hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? t("Deleting…") : t("Delete permanently")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
