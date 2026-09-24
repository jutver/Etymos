import { useState } from "react";
import { Robot, Sparkle, X } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import type { AiDetection } from "@etymos/shared";
import { Modal } from "../../components/ui/Modal";
import { aiLevelLabel, translateAiText } from "../../lib/aiDetection";
import { trackEvent } from "../../lib/analytics";
import { t, currentLocale } from "../../lib/i18n";

/**
 * "AI content" indicator for the report top bar. Deliberately violet and kept
 * apart from the similarity chip: machine-written text is a different kind of
 * signal from plagiarism (DESIGN.md's Functional Wall Rule), so it never shares
 * the severity colours or gets folded into the similarity score.
 *
 * Free plan sees a locked chip that leads to the paywall; paid plans see the
 * score and can open the detail dialog (why, which paragraphs, limits).
 */
export interface AiContentChipProps {
  detection: AiDetection | undefined;
  locked: boolean;
  onUpgrade: () => void;
}

const LEVEL_CHIP = {
  low: "border-line bg-white text-ink-700",
  possible: "border-ai-flag-line bg-ai-flag-bg/60 text-ai-flag",
  likely: "border-ai-flag-line bg-ai-flag-bg text-ai-flag",
} as const;

export function AiContentChip({ detection, locked, onUpgrade }: AiContentChipProps) {
  const [open, setOpen] = useState(false);

  // Old reports (checked before the detector existed) and checks where it could
  // not run simply show nothing: an empty chip would read as "no AI found".
  if (!detection || !detection.available) return null;

  if (locked) {
    return (
      <button
        type="button"
        onClick={onUpgrade}
        title={t("AI-generated content detection — upgrade to unlock")}
        className="hidden items-center gap-1.5 rounded-full border border-line bg-white px-2.5 py-1 text-xs font-semibold text-ink-500 transition-colors hover:border-ai-flag-line hover:text-ai-flag sm:inline-flex"
      >
        <Robot size={13} weight="bold" />
        {t("AI content")}<Sparkle size={9} weight="fill" className="text-brand-500" />
      </button>
    );
  }

  const score = Math.round(detection.overallScore);
  const flagged = detection.segments
    .filter((s) => s.score >= 60)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          trackEvent("ai_detection_opened");
        }}
        title={t("{{aiLevelLabel}} — click for details", { aiLevelLabel: aiLevelLabel(detection.level) })}
        className={cn(
          "hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold tabular-nums transition-colors hover:brightness-95 sm:inline-flex",
          LEVEL_CHIP[detection.level],
        )}
      >
        <Robot size={13} weight="bold" />
        {score}{t("% AI")}</button>

      <Modal open={open} onClose={() => setOpen(false)} maxWidth="max-w-lg" labelledBy="ai-content-title">
        <div className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-full bg-ai-flag-bg text-ai-flag">
                <Robot size={22} weight="bold" />
              </span>
              <div>
                <h2 id="ai-content-title" className="text-h3 font-bold tracking-tight text-navy-900">
                  {t("AI-generated content")}</h2>
                <p className="text-sm text-ink-500">{aiLevelLabel(detection.level)}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={t("Close")}
              className="rounded-full p-1.5 text-ink-400 transition-colors hover:bg-surface-muted hover:text-ink-700"
            >
              <X size={18} />
            </button>
          </div>

          <div className="mt-5">
            <div className="flex items-baseline justify-between">
              <span className="text-3xl font-extrabold tabular-nums text-ai-flag">{score}%</span>
              <span className="text-xs text-ink-500">
                {detection.analyzedWords.toLocaleString(currentLocale())}{" "}{t("words analysed")}{detection.aiShare > 0 && <> · {Math.round(detection.aiShare)}{t("% in AI-looking paragraphs")}</>}
              </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-ai-flag-bg" role="presentation">
              <div className="h-full rounded-full bg-ai-flag" style={{ width: `${Math.min(100, Math.max(2, score))}%` }} />
            </div>
          </div>

          {detection.confidence === "low" && (
            <p className="mt-4 rounded-[var(--radius-input)] border border-line bg-surface-muted px-3 py-2 text-xs text-ink-600">
              {t("Lower confidence: this text is short or not in English, and the detector was tuned on English. Treat the number as a hint only.")}</p>
          )}

          <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-ink-500">{t("Why")}</h3>
          <ul className="mt-2 space-y-2 text-sm text-ink-700">
            {detection.reasons.map((reason) => (
              <li key={reason} className="flex gap-2">
                <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-ai-flag" />
                <span>{translateAiText(reason)}</span>
              </li>
            ))}
          </ul>

          {flagged.length > 0 && (
            <>
              <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-ink-500">
                {t("Paragraphs that look machine-written")}</h3>
              <ul className="mt-2 space-y-2">
                {flagged.map((segment) => (
                  <li
                    key={`${segment.start}-${segment.end}`}
                    className="rounded-[var(--radius-input)] border border-ai-flag-line bg-ai-flag-bg/50 px-3 py-2"
                  >
                    <p className="text-xs font-semibold tabular-nums text-ai-flag">
                      {Math.round(segment.score)}% · {segment.words}{" "}{t("words")}</p>
                    {segment.excerpt && <p className="mt-0.5 text-sm text-ink-700">{segment.excerpt}</p>}
                  </li>
                ))}
              </ul>
            </>
          )}

          {detection.disclaimer && <p className="mt-5 text-xs text-ink-400">{translateAiText(detection.disclaimer)}</p>}
        </div>
      </Modal>
    </>
  );
}
