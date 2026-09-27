import { useState } from "react";
import { CaretDown, CaretUp, Robot } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import type { AiDetection } from "@etymos/shared";
import { Button } from "../../components/ui/Button";
import { aiLevelLabel, translateAiText } from "../../lib/aiDetection";
import { trackEvent } from "../../lib/analytics";
import { AI_DETECTION_SOURCES, explainAiSegment } from "../../lib/aiSegmentExplanation";
import { t, currentLocale } from "../../lib/i18n";

const LEVEL_CHIP = {
  low: "border-line bg-white text-ink-700",
  possible: "border-ai-flag-line bg-ai-flag-bg/60 text-ai-flag",
  likely: "border-ai-flag-line bg-ai-flag-bg text-ai-flag",
} as const;

export interface AiDetectionSectionProps {
  detection: AiDetection | undefined;
  locked: boolean;
  onUpgrade: () => void;
  /** Currently focused segment (Document/Original view scrolled to it) — same
   * id convention as `onSegmentClick`'s argument, `${start}-${end}`. */
  activeSegmentId?: string | null;
  /** Jump to a flagged paragraph in whichever view (Document or Original) is
   * open — the same "pick a sidebar card, see it highlighted in the
   * document" behaviour matched sources already have. Segments are
   * identified by `${segment.start}-${segment.end}` (stable within one
   * report, and already how AiContentChip keys its own list). */
  onSegmentClick?: (segmentId: string) => void;
  /** Open the "Why" details from the start (the sidebar's own AI tab). */
  defaultExpanded?: boolean;
}

/**
 * Sidebar counterpart to the top-bar `AiContentChip` (ReportTopBar's
 * scoreSlot): the same `doc.aiDetection` data, but shown as its own always-
 * visible section next to the matched sources instead of a chip you have to
 * click to open a modal — same "explanation lives next to the score"
 * treatment SourcesSidebar already gives similarity matches via MatchCard.
 * Purely additive: AiContentChip stays exactly as it is, this is a second
 * surface for the same data, not a replacement.
 */
export function AiDetectionSection({ detection, locked, onUpgrade, activeSegmentId, onSegmentClick, defaultExpanded }: AiDetectionSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);

  // Old reports (checked before the detector existed) and checks where it
  // could not run: show nothing, same rule AiContentChip follows — an empty
  // section would read as "no AI found" instead of "not measured".
  if (!detection || !detection.available) return null;

  if (locked) {
    return (
      <div className="mt-3 shrink-0 rounded-[var(--radius-card)] border border-dashed border-ai-flag-line bg-ai-flag-bg/20 p-4 text-center">
        <Robot size={20} weight="bold" className="mx-auto text-ai-flag" />
        <p className="mt-2 text-xs font-semibold text-navy-900">{t("AI content")}</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-500">
          {t("Upgrade to see which paragraphs look AI-written.")}</p>
        <Button size="sm" className="mt-3 h-8 px-3 text-xs" onClick={onUpgrade}>
          {t("Unlock")}</Button>
      </div>
    );
  }

  const score = Math.round(detection.overallScore);
  const flagged = detection.segments
    .filter((s) => s.score >= 60)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return (
    <div className="mt-3 shrink-0 rounded-[var(--radius-card)] border border-line bg-white p-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ai-flag-bg text-ai-flag">
            <Robot size={15} weight="bold" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-bold text-navy-900">{t("AI-generated content")}</p>
            <p className="truncate text-[11px] text-ink-500">{aiLevelLabel(detection.level)}</p>
          </div>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold tabular-nums",
            LEVEL_CHIP[detection.level],
          )}
        >
          {score}{t("% AI")}</span>
      </div>

      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-ai-flag-bg" role="presentation">
        <div
          className="h-full rounded-full bg-ai-flag"
          style={{ width: `${Math.min(100, Math.max(2, score))}%` }}
        />
      </div>
      <p className="mt-1.5 text-[11px] text-ink-500">
        {detection.analyzedWords.toLocaleString(currentLocale())}{" "}{t("words analysed")}
        {detection.aiShare > 0 && <> · {Math.round(detection.aiShare)}{t("% in AI-looking paragraphs")}</>}
      </p>

      {detection.confidence === "low" && (
        <p className="mt-2 rounded-[var(--radius-input)] border border-line bg-surface-muted px-2.5 py-1.5 text-[11px] text-ink-600">
          {t("Lower confidence: this text is short or not in English, and the detector was tuned on English. Treat the number as a hint only.")}</p>
      )}

      <button
        type="button"
        onClick={() => {
          const next = !expanded;
          setExpanded(next);
          if (next) trackEvent("ai_detection_opened");
        }}
        aria-expanded={expanded}
        className="mt-2.5 flex w-full items-center justify-between text-[11px] font-semibold text-ink-500 transition-colors hover:text-ink-900"
      >
        {t("Why")}
        {expanded ? <CaretUp size={12} /> : <CaretDown size={12} />}
      </button>

      {expanded && (
        <>
          <ul className="mt-2 space-y-1.5 text-xs text-ink-700">
            {detection.reasons.map((reason) => (
              <li key={reason} className="flex gap-1.5">
                <span aria-hidden="true" className="mt-1.5 size-1 shrink-0 rounded-full bg-ai-flag" />
                <span>{translateAiText(reason)}</span>
              </li>
            ))}
          </ul>

          {flagged.length > 0 && (
            <>
              <p className="mt-3 text-[10px] font-semibold uppercase tracking-wide text-ink-500">
                {t("Paragraphs that look machine-written")}</p>
              <ul className="mt-1.5 space-y-1.5">
                {flagged.map((segment) => {
                  const segmentId = `${segment.start}-${segment.end}`;
                  const isActive = activeSegmentId === segmentId;
                  return (
                    <li key={segmentId}>
                      <button
                        type="button"
                        disabled={!onSegmentClick}
                        onClick={() => onSegmentClick?.(segmentId)}
                        title={onSegmentClick ? t("Find it in the document") : undefined}
                        className={cn(
                          "w-full rounded-[var(--radius-input)] border px-2.5 py-1.5 text-left transition-colors",
                          isActive
                            ? "border-ai-flag bg-ai-flag-bg"
                            : "border-ai-flag-line bg-ai-flag-bg/50",
                          onSegmentClick && "cursor-pointer hover:border-ai-flag hover:bg-ai-flag-bg",
                        )}
                      >
                        <p className="text-[11px] font-semibold tabular-nums text-ai-flag">
                          {Math.round(segment.score)}% · {segment.words}{" "}{t("words")}</p>
                        {segment.excerpt && <p className="mt-0.5 text-xs text-ink-700">{segment.excerpt}</p>}
                        <ul className="mt-1.5 space-y-1 border-t border-ai-flag-line/60 pt-1.5">
                          {explainAiSegment(segment).map((point) => (
                            <li key={point.text} className="flex gap-1.5 text-[11px] leading-relaxed text-ink-600">
                              <span aria-hidden="true" className="mt-1.5 size-1 shrink-0 rounded-full bg-ai-flag" />
                              <span>
                                {point.text}
                                {point.sources.length > 0 && (
                                  <span className="ml-0.5 text-ink-400">
                                    {point.sources.map((id) => `[${id}]`).join("")}</span>
                                )}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {detection.disclaimer && (
            <p className="mt-3 text-[10px] text-ink-400">{translateAiText(detection.disclaimer)}</p>
          )}

          <p className="mt-2 text-[10px] text-ink-400">
            {t("Detectors of this kind misjudge writing by non-native English speakers more often.")}{" "}[4]</p>
          <p className="mt-3 text-[10px] font-semibold uppercase tracking-wide text-ink-500">
            {t("Sources")}</p>
          <ol className="mt-1 space-y-1 text-[10px] leading-relaxed text-ink-500">
            {AI_DETECTION_SOURCES.map((source) => (
              <li key={source.id} className="flex gap-1">
                <span className="shrink-0 tabular-nums">[{source.id}]</span>
                <a href={source.url} target="_blank" rel="noopener noreferrer" className="hover:text-ink-900 hover:underline">
                  {source.citation}</a>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
