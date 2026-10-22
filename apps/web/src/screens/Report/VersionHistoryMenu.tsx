import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, ArrowDown, ArrowUp } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { t, currentLocale } from "../../lib/i18n";
import { scoreChange, versionChanges, versionTag } from "./versionStats";

/** The Save & re-check that ran on a version (document_checks). */
export interface VersionCheck {
  id: string;
  /** Used a check (vs a free re-check). */
  paid: boolean;
  /** Similarity after this re-check, and before it (null when unknown). */
  score: number;
  previousScore: number | null;
  /** AI-writing score after and before; null when detection didn't run. */
  aiScore: number | null;
  previousAiScore: number | null;
}

export interface DocumentVersion {
  id: string;
  label: string;
  savedAt: string;
  wordCount: number;
  /** Full document text at the time of the save. */
  html: string;
  /** Set when this version was re-checked; otherwise it is an unchecked draft. */
  check?: VersionCheck;
  /** Share of the text changed since the version before it (0..1), when known. */
  changedRatio?: number | null;
}

/** Lower is better for both similarity and AI-writing scores. */
function ScoreDelta({ label, change }: { label: string; change: { value: number; delta: number | null } | null }) {
  if (!change) {
    return (
      <span className="text-ink-400">
        {label} —
      </span>
    );
  }
  const { value, delta } = change;
  return (
    <span className="inline-flex items-center gap-1 text-ink-700">
      {label} {value}%
      {delta !== null && (
        <span
          className={cn(
            "inline-flex items-center font-semibold tabular-nums",
            delta < 0 ? "text-success" : delta > 0 ? "text-severity-high" : "text-ink-400",
          )}
          aria-label={
            delta < 0
              ? t("down {{points}} points", { points: -delta })
              : delta > 0
                ? t("up {{points}} points", { points: delta })
                : t("no change")
          }
        >
          {delta < 0 ? <ArrowDown size={10} weight="bold" /> : delta > 0 ? <ArrowUp size={10} weight="bold" /> : "±"}
          {Math.abs(delta)}
        </span>
      )}
    </span>
  );
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
  showAi = true,
  children,
}: {
  versions: DocumentVersion[];
  /** False on the Free tier, where AI-content detection is locked. */
  showAi?: boolean;
  onRestore: (version: DocumentVersion) => void;
  children: (toggle: () => void, open: boolean) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Only worked out while the menu is open: older versions may need a diff.
  const changes = useMemo(() => (open ? versionChanges(versions) : new Map<string, number>()), [open, versions]);

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
          className="absolute right-0 top-[calc(100%+8px)] z-30 w-80 max-w-[calc(100vw-1.5rem)] rounded-[var(--radius-card)] border border-line bg-white p-1.5 shadow-[var(--shadow-pop)]"
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
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-ink-900">{t(v.label)}</span>
                        <span
                          className={cn(
                            "shrink-0 rounded-full px-1.5 py-px text-micro font-semibold",
                            v.check ? "bg-brand-100 text-brand-700" : "bg-surface-tint text-ink-500",
                          )}
                          title={v.check ? (v.check.paid ? t("Re-checked with 1 check") : t("Free re-check")) : undefined}
                        >
                          {versionTag(v)}
                        </span>
                      </span>
                      <span className="block text-xs text-ink-500">
                        {v.savedAt} · {v.wordCount.toLocaleString(currentLocale())}{" "}{t("words")}
                        {changes.has(v.id) && (
                          <>
                            {" · "}
                            {t("{{percent}}% changed", { percent: Math.round((changes.get(v.id) ?? 0) * 100) })}
                          </>
                        )}
                      </span>
                      {v.check && (
                        <span className="mt-0.5 flex flex-wrap gap-x-3 text-xs">
                          <ScoreDelta label={t("Similarity")} change={scoreChange(v.check.score, v.check.previousScore)} />
                          {showAi && (
                            <ScoreDelta label={t("AI")} change={scoreChange(v.check.aiScore, v.check.previousAiScore)} />
                          )}
                        </span>
                      )}
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
