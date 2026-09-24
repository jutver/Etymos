import { useEffect, useRef, useState } from "react";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { t, currentLocale } from "../../lib/i18n";

export interface DocumentVersion {
  id: string;
  label: string;
  savedAt: string;
  wordCount: number;
  /** Full document text at the time of the save. */
  html: string;
}

/**
 * Small popover listing saved versions.
 *
 * Uses a render-prop for its trigger so the top bar keeps ownership of the
 * button styling. Focus is *not* trapped: Escape closes, Tab walks out
 * naturally, and an outside click dismisses.
 */
export function VersionHistoryMenu({
  versions,
  onRestore,
  children,
}: {
  versions: DocumentVersion[];
  onRestore: (version: DocumentVersion) => void;
  children: (toggle: () => void, open: boolean) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      {children(() => setOpen((v) => !v), open)}

      {open && (
        <div
          role="menu"
          aria-label={t("Version history")}
          className="absolute right-0 top-[calc(100%+8px)] z-30 w-72 rounded-[var(--radius-card)] border border-line bg-white p-1.5 shadow-[var(--shadow-pop)]"
        >
          <p className="px-2.5 py-2 text-micro font-bold uppercase tracking-wide text-ink-500">
            {t("Version history")}</p>

          {versions.length === 0 ? (
            <p className="px-2.5 pb-3 pt-1 text-xs leading-relaxed text-ink-500">
              {t("No saved versions yet. Each time you save, a snapshot lands here.")}</p>
          ) : (
            <ul className="max-h-72 overflow-y-auto scrollbar-thin">
              {versions.map((v, i) => (
                <li key={v.id}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onRestore(v);
                      setOpen(false);
                    }}
                    className="group flex w-full items-center gap-2 rounded-[var(--radius-input)] px-2.5 py-2 text-left transition-colors hover:bg-surface-tint"
                  >
                    <span
                      className={cn(
                        "mt-0.5 size-1.5 shrink-0 rounded-full",
                        i === 0 ? "bg-brand-500" : "bg-ink-300",
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink-900">
                        {t(v.label)}
                      </span>
                      <span className="block text-xs text-ink-500">
                        {v.savedAt} · {v.wordCount.toLocaleString(currentLocale())}{" "}{t("words")}</span>
                    </span>
                    <ArrowCounterClockwise
                      size={14}
                      className="shrink-0 text-ink-300 transition-colors group-hover:text-brand-600"
                    />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
