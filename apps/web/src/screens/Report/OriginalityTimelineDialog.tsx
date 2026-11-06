import { useEffect, useState } from "react";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { Modal, ModalCloseButton } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { t, tn, currentLocale } from "../../lib/i18n";
import { ScoreChart, type ChartSpacing } from "./ScoreChart";
import { ScoreDelta, type DocumentVersion } from "./VersionHistoryMenu";
import { formatPointDate, isCheckPoint, type Timeline, type TimelinePoint } from "./versionTimeline";

const KIND_LABELS: Record<TimelinePoint["kind"], string> = {
  upload: "Original upload",
  free_recheck: "Free re-check",
  paid_recheck: "Re-checked with 1 check",
  draft: "Draft",
};

/** The check before `point`, for its ±points. */
function previousCheck(points: TimelinePoint[], point: TimelinePoint): TimelinePoint | null {
  const i = points.indexOf(point);
  for (let j = i - 1; j >= 0; j--) if (isCheckPoint(points[j])) return points[j];
  return null;
}

function Stat({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-line bg-surface-muted px-3 py-2.5">
      <p className="text-micro font-bold uppercase tracking-wide text-ink-500">{label}</p>
      <div className="mt-1 text-sm font-semibold text-navy-900">{children}</div>
      {hint && <p className="mt-0.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

/** "32% → 14%" with the change beside it; lower is better. */
function FromTo({ first, latest, delta }: { first: number; latest: number; delta: number }) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      <span className="tabular-nums">
        {first}% → {latest}%
      </span>
      <span className="text-xs font-semibold">
        <ScoreDelta label="" change={{ value: latest, delta }} hideValue />
      </span>
    </span>
  );
}

/**
 * Originality timeline: the document's Similarity (and AI-writing) score at
 * each check, with saved drafts in between. Opened from Version History.
 */
export default function OriginalityTimelineDialog({
  open,
  onClose,
  timeline,
  showAi,
  onRestore,
}: {
  open: boolean;
  onClose: () => void;
  timeline: Timeline;
  showAi: boolean;
  onRestore: (version: DocumentVersion) => void;
}) {
  const { points, summary } = timeline;
  const latestCheck = [...points].reverse().find(isCheckPoint) ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(latestCheck?.id ?? null);
  const [spacing, setSpacing] = useState<ChartSpacing>("order");

  // Opening again starts from the latest check.
  useEffect(() => {
    if (open) setSelectedId(latestCheck?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selected = points.find((p) => p.id === selectedId) ?? latestCheck;
  const before = selected ? previousCheck(points, selected) : null;
  const aiShown = showAi && points.some((p) => p.ai !== null);

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-2xl" labelledBy="timeline-dialog-title">
      <div className="relative max-h-[calc(100dvh-2rem)] overflow-y-auto p-5 sm:p-6">
        <ModalCloseButton onClose={onClose} />
        <h2 id="timeline-dialog-title" className="pr-8 text-h3 font-bold text-navy-900">
          {t("Originality timeline")}
        </h2>
        <p className="mt-1 text-sm text-ink-500">
          {t("How your scores changed with each check. Lower means more original.")}
        </p>

        {summary && (
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label={t("Similarity")} hint={t("Upload → latest")}>
              <FromTo first={summary.first} latest={summary.latest} delta={summary.delta} />
            </Stat>
            {showAi && summary.aiDelta !== null && summary.aiFirst !== null && summary.aiLatest !== null ? (
              <Stat label={t("AI writing")} hint={t("Upload → latest")}>
                <FromTo first={summary.aiFirst} latest={summary.aiLatest} delta={summary.aiDelta} />
              </Stat>
            ) : null}
            <Stat label={t("Best similarity")} hint={formatPointDate(summary.best.at) || t(summary.best.label)}>
              <span className="tabular-nums">{summary.best.similarity}%</span>
            </Stat>
            <Stat label={t("Revisions")}>
              <span>
                {tn(summary.checks, "{{count}} check", "{{count}} checks")}
                <span className="font-normal text-ink-500">
                  {" · "}
                  {tn(summary.drafts, "{{count}} draft", "{{count}} drafts")}
                </span>
              </span>
            </Stat>
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
          <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-600" aria-label={t("Legend")}>
            <li className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="size-2.5 rounded-full bg-brand-600" />
              {t("Similarity")}
            </li>
            {aiShown && (
              <li className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="size-2.5 rounded-full border-2 border-navy-700/60 bg-white" />
                {t("AI writing")}
              </li>
            )}
            <li className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2.5 w-1 rounded-full bg-ink-300" />
              {t("Saved draft")}
            </li>
          </ul>
          <div
            role="radiogroup"
            aria-label={t("Spacing")}
            className="relative grid grid-cols-2 rounded-full border border-line bg-surface-muted p-0.5 text-xs font-medium"
          >
            {/* The white pill slides under whichever option is on. */}
            <span
              aria-hidden="true"
              className={cn(
                "absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-full bg-white shadow-sm",
                "transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
                spacing === "date" && "translate-x-full",
              )}
            />
            {(["order", "date"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={spacing === value}
                onClick={() => setSpacing(value)}
                className={cn(
                  "relative rounded-full px-2.5 py-1 transition-colors duration-300",
                  spacing === value ? "text-navy-900" : "text-ink-500 hover:text-ink-700",
                )}
              >
                {value === "order" ? t("In order") : t("By date")}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-2">
          <ScoreChart points={points} showAi={showAi} spacing={spacing} selectedId={selected?.id ?? null} onSelect={setSelectedId} />
        </div>

        {selected && (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border border-line px-3.5 py-3" aria-live="polite">
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-x-2 text-sm">
                <span className="font-semibold text-ink-900">{t(selected.label)}</span>
                {/* The upload's name already says what it is. */}
                {selected.kind !== "upload" && (
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-px text-micro font-semibold",
                      isCheckPoint(selected) ? "bg-brand-100 text-brand-700" : "bg-surface-tint text-ink-500",
                    )}
                  >
                    {t(KIND_LABELS[selected.kind])}
                  </span>
                )}
                {formatPointDate(selected.at) && <span className="text-xs text-ink-500">{formatPointDate(selected.at)}</span>}
              </p>
              {isCheckPoint(selected) ? (
                <p className="mt-1 flex flex-wrap gap-x-3 text-xs">
                  <ScoreDelta
                    label={t("Similarity")}
                    change={{ value: selected.similarity!, delta: before ? selected.similarity! - before.similarity! : null }}
                  />
                  {showAi && (
                    <ScoreDelta
                      label={t("AI")}
                      change={
                        selected.ai === null
                          ? null
                          : { value: selected.ai, delta: before?.ai != null ? selected.ai - before.ai : null }
                      }
                    />
                  )}
                </p>
              ) : (
                <p className="mt-1 text-xs text-ink-500">{t("Saved without a re-check, so it has no score.")}</p>
              )}
              {(selected.wordCount !== null || selected.changedRatio !== null) && (
                <p className="mt-0.5 text-xs text-ink-500">
                  {selected.wordCount !== null && (
                    <>
                      {selected.wordCount.toLocaleString(currentLocale())} {t("words")}
                    </>
                  )}
                  {selected.wordCount !== null && selected.changedRatio !== null && " · "}
                  {selected.changedRatio !== null &&
                    t("{{percent}}% changed", { percent: Math.round(selected.changedRatio * 100) })}
                </p>
              )}
            </div>
            {selected.version && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  onRestore(selected.version!);
                  onClose();
                }}
              >
                <ArrowCounterClockwise size={14} />
                {t("Restore")}
              </Button>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
