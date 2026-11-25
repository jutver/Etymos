import { useMemo, useState } from "react";
import {
  ChartPieSlice,
  CheckCircle,
  Globe,
  GraduationCap,
  ShieldCheck,
  Sparkle,
  X,
} from "@phosphor-icons/react";
import { cn, type MatchedSource, type PublishedPaperMatch, type Severity } from "@etymos/shared";
import { severityConfig, statusConfig, statusFromScore } from "../../components/Severity";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { PublishedPaperNotice } from "./PublishedPaperNotice";
import { trackEvent } from "../../lib/analytics";
import { currentLocale, t, tn } from "../../lib/i18n";
import { sanitizeSourceTitle } from "../../lib/sourceTitle";

const SEVERITY_ORDER: Record<Severity, number> = {
  high: 3,
  moderate: 2,
  low: 1,
};

const SEVERITIES: Severity[] = ["high", "moderate", "low"];

export interface TopMatchedSource {
  key: string;
  title: string;
  author: string;
  sourceKind: MatchedSource["sourceKind"];
  highestPercent: number;
  passageCount: number;
  highestSeverity: Severity;
  firstMatchId: string;
}

export interface SimilaritySummaryStats {
  countsBySeverity: Record<Severity, number>;
  countsByDetection: { traditional: number; semantic: number };
  countsByKind: { academic: number; web: number };
  resolvedCount: number;
  uniqueSourceCount: number;
  topSources: TopMatchedSource[];
}

export function summarizeSimilarity(
  matches: MatchedSource[],
  resolvedIds: Set<string>,
): SimilaritySummaryStats {
  const countsBySeverity: Record<Severity, number> = { high: 0, moderate: 0, low: 0 };
  const countsByDetection = { traditional: 0, semantic: 0 };
  const countsByKind = { academic: 0, web: 0 };
  let resolvedCount = 0;
  const sourceGroups = new Map<string, TopMatchedSource>();

  for (const match of matches) {
    countsBySeverity[match.severity] += 1;
    countsByDetection[match.detectionType] += 1;
    countsByKind[match.sourceKind] += 1;
    if (resolvedIds.has(match.id)) resolvedCount += 1;

    const cleanTitle =
      sanitizeSourceTitle(match.sourceTitle, { isAcademic: match.sourceKind === "academic" }) ||
      match.sourceTitle;
    const rawKey = (match.sourceUrl?.trim() || cleanTitle.trim() || match.sourceTitle.trim() || match.id).toLowerCase();
    const existing = sourceGroups.get(rawKey);
    if (!existing) {
      sourceGroups.set(rawKey, {
        key: rawKey,
        title: cleanTitle,
        author: match.sourceAuthor,
        sourceKind: match.sourceKind,
        highestPercent: match.matchPercent,
        passageCount: 1,
        highestSeverity: match.severity,
        firstMatchId: match.id,
      });
    } else {
      existing.passageCount += 1;
      if (match.matchPercent > existing.highestPercent) {
        existing.highestPercent = match.matchPercent;
      }
      if (SEVERITY_ORDER[match.severity] > SEVERITY_ORDER[existing.highestSeverity]) {
        existing.highestSeverity = match.severity;
      }
    }
  }

  const topSources = Array.from(sourceGroups.values())
    .sort((a, b) => b.highestPercent - a.highestPercent || b.passageCount - a.passageCount)
    .slice(0, 5);

  return {
    countsBySeverity,
    countsByDetection,
    countsByKind,
    resolvedCount,
    uniqueSourceCount: sourceGroups.size,
    topSources,
  };
}

export interface SimilaritySummaryContentProps {
  score: number;
  estimated?: boolean;
  wordCount: number;
  matches: MatchedSource[];
  resolvedIds: Set<string>;
  lockedCount?: number;
  publishedPaperMatch?: PublishedPaperMatch;
  onSelectMatch?: (matchId: string) => void;
  onUpgrade?: () => void;
  onClose: () => void;
}

export function SimilaritySummaryContent({
  score,
  estimated = false,
  wordCount,
  matches,
  resolvedIds,
  lockedCount = 0,
  publishedPaperMatch,
  onSelectMatch,
  onUpgrade,
  onClose,
}: SimilaritySummaryContentProps) {
  const status = statusFromScore(score);
  const statusMeta = statusConfig[status];
  const summary = useMemo(() => summarizeSimilarity(matches, resolvedIds), [matches, resolvedIds]);

  return (
    <div className="p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className={cn("flex size-10 items-center justify-center rounded-full", statusMeta.bg, statusMeta.text)}>
            <ChartPieSlice size={22} weight="bold" aria-hidden="true" />
          </span>
          <div>
            <h2 id="similarity-summary-title" className="text-h3 font-bold tracking-tight text-navy-900">
              {t("Similarity summary")}
            </h2>
            <p className="text-sm text-ink-500">{t(statusMeta.label)}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("Close")}
          className="rounded-full p-1.5 text-ink-400 transition-colors hover:bg-surface-muted hover:text-ink-700"
        >
          <X size={18} />
        </button>
      </div>

      <div className="mt-5">
        <div className="flex items-baseline justify-between gap-3">
          <span className={cn("text-3xl font-extrabold tabular-nums", statusMeta.text)}>
            {estimated && <span aria-label={t("estimated")}>≈</span>}
            {score}%
          </span>
          <span className="text-xs text-ink-500">
            {wordCount.toLocaleString(currentLocale())}{" "}{t("words analysed")} ·{" "}
            {tn(matches.length, "{{count}} matched source", "{{count}} matched sources")}
          </span>
        </div>
        <div className={cn("mt-2 h-2 overflow-hidden rounded-full", statusMeta.bg)} role="presentation">
          <div
            className={cn("h-full rounded-full", statusMeta.bar)}
            style={{ width: `${Math.min(100, Math.max(score > 0 ? 2 : 0, score))}%` }}
          />
        </div>
      </div>

      {estimated && (
        <p className="mt-4 rounded-[var(--radius-input)] border border-line bg-surface-muted px-3 py-2 text-xs text-ink-600">
          {t(
            "Estimated similarity {{score}}% after your edits. Edited passages were only compared with the sources already in this report; a full re-check gives the exact score.",
            { score },
          )}
        </p>
      )}

      {publishedPaperMatch?.detected && (
        <div className="mt-4">
          <PublishedPaperNotice match={publishedPaperMatch} className="mb-0" />
        </div>
      )}

      <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-ink-500">
        {t("Severity breakdown")}
      </h3>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {SEVERITIES.map((sev) => {
          const c = severityConfig[sev];
          const count = summary.countsBySeverity[sev];
          return (
            <div
              key={sev}
              className={cn(
                "rounded-[var(--radius-input)] border px-3 py-2",
                count > 0 ? cn(c.bg, c.line, c.text) : "border-line bg-surface-muted/60 text-ink-500",
              )}
            >
              <div className="flex items-center gap-1.5">
                <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", c.dot)} />
                <span className="text-lg font-bold tabular-nums leading-none">{count}</span>
              </div>
              <p className="mt-1 truncate text-[11px] font-medium">{t(c.label)}</p>
            </div>
          );
        })}
      </div>

      {matches.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-ink-600">
          <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-tint px-2.5 py-0.5 font-medium">
            {tn(summary.uniqueSourceCount, "{{count}} unique source", "{{count}} unique sources")}
          </span>
          {summary.countsByKind.academic > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-tint px-2.5 py-0.5 font-medium">
              <GraduationCap size={12} weight="bold" aria-hidden="true" />
              {summary.countsByKind.academic} {t("Academic")}
            </span>
          )}
          {summary.countsByKind.web > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-tint px-2.5 py-0.5 font-medium">
              <Globe size={12} weight="bold" aria-hidden="true" />
              {summary.countsByKind.web} {t("Web")}
            </span>
          )}
          {summary.countsByDetection.traditional > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-tint px-2.5 py-0.5 font-medium">
              {summary.countsByDetection.traditional} {t("Exact & phrase")}
            </span>
          )}
          {summary.countsByDetection.semantic > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-tint px-2.5 py-0.5 font-medium">
              {summary.countsByDetection.semantic} {t("Paraphrased")}
            </span>
          )}
          {summary.resolvedCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-success/20 bg-success-bg px-2.5 py-0.5 font-medium text-success">
              <CheckCircle size={12} weight="bold" aria-hidden="true" />
              {tn(summary.resolvedCount, "{{count}} passage fixed", "{{count}} passages fixed")}
            </span>
          )}
        </div>
      )}

      {matches.length === 0 ? (
        <div className="mt-5 flex items-start gap-3 rounded-[var(--radius-input)] border border-success/20 bg-success-bg/70 px-3.5 py-3">
          <ShieldCheck size={20} className="mt-0.5 shrink-0 text-success" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-navy-900">{t("No matched sources")}</p>
            <p className="mt-0.5 text-xs text-ink-600">
              {t("Nothing in this document overlapped the sources we scanned.")}
            </p>
          </div>
        </div>
      ) : (
        <>
          <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-ink-500">
            {t("Top matched sources")}
          </h3>
          <ul className="mt-2 space-y-2">
            {summary.topSources.map((src) => {
              const sev = severityConfig[src.highestSeverity];
              return (
                <li key={src.key}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelectMatch?.(src.firstMatchId);
                      onClose();
                    }}
                    className="flex w-full items-center gap-2.5 rounded-[var(--radius-input)] border border-line bg-surface-tint/60 px-3 py-2 text-left transition-colors hover:border-brand-300 hover:bg-surface-muted"
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-white text-ink-500 border border-line/70">
                      {src.sourceKind === "academic" ? (
                        <GraduationCap size={14} weight="bold" aria-hidden="true" />
                      ) : (
                        <Globe size={14} weight="bold" aria-hidden="true" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink-900">{src.title}</span>
                      {src.author && (
                        <span className="block truncate text-xs text-ink-500">{src.author}</span>
                      )}
                    </span>
                    <span className="shrink-0 text-right">
                      <span className={cn("block text-xs font-bold tabular-nums", sev.text)}>
                        {src.highestPercent}%
                      </span>
                      <span className="block text-[11px] text-ink-500">
                        {tn(src.passageCount, "{{count}} passage", "{{count}} passages")}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {lockedCount > 0 && onUpgrade && (
        <div className="mt-4 flex flex-col items-center rounded-[var(--radius-input)] border border-dashed border-brand-300 bg-brand-100/30 p-3.5 text-center">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-navy-900">
            <Sparkle size={14} weight="fill" className="text-brand-500" aria-hidden="true" />
            <span>
              {lockedCount} {t("more found by Semantic Detection")}
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-ink-500">
            {t("Upgrade to catch paraphrased and reworded copying too.")}
          </p>
          <Button
            size="sm"
            className="mt-2.5 h-8 px-3 text-xs"
            onClick={() => {
              onClose();
              onUpgrade();
            }}
          >
            {t("Unlock")}
          </Button>
        </div>
      )}

      <p className="mt-5 text-xs text-ink-400">
        {t(
          "Originality & overlap reflect the sources scanned for this report. Quotes, references, and common academic phrasing may still appear as matches.",
        )}
      </p>
    </div>
  );
}

export interface SimilaritySummaryChipProps {
  score: number;
  estimated?: boolean;
  checking?: boolean;
  wordCount: number;
  matches: MatchedSource[];
  resolvedIds: Set<string>;
  lockedCount?: number;
  publishedPaperMatch?: PublishedPaperMatch;
  onSelectMatch?: (matchId: string) => void;
  onUpgrade?: () => void;
}

export function SimilaritySummaryChip({
  score,
  estimated = false,
  checking = false,
  wordCount,
  matches,
  resolvedIds,
  lockedCount = 0,
  publishedPaperMatch,
  onSelectMatch,
  onUpgrade,
}: SimilaritySummaryChipProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  const status = statusFromScore(score);
  const statusMeta = statusConfig[status];

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setMounted(true);
          setOpen(true);
          trackEvent("similarity_summary_opened");
        }}
        title={
          estimated
            ? t(
                "Estimated similarity {{score}}% after your edits. Edited passages were only compared with the sources already in this report; a full re-check gives the exact score.",
                { score },
              )
            : t("Similarity score {{score}}% — click for details", { score })
        }
        className={cn(
          "hidden shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold tabular-nums transition-colors hover:brightness-95 focus-visible:outline-2 focus-visible:outline-brand-500 sm:inline-flex",
          statusMeta.text,
          statusMeta.bg,
          statusMeta.line,
        )}
      >
        {checking && (
          <span
            aria-hidden="true"
            className="size-2.5 animate-spin motion-reduce:animate-none rounded-full border border-current border-t-transparent"
          />
        )}
        {estimated && <span aria-label={t("estimated")}>≈</span>}
        {score}
        {t("% similar")}
      </button>

      {mounted && (
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          maxWidth="max-w-lg"
          labelledBy="similarity-summary-title"
        >
          <SimilaritySummaryContent
            score={score}
            estimated={estimated}
            wordCount={wordCount}
            matches={matches}
            resolvedIds={resolvedIds}
            lockedCount={lockedCount}
            publishedPaperMatch={publishedPaperMatch}
            onSelectMatch={onSelectMatch}
            onUpgrade={onUpgrade}
            onClose={() => setOpen(false)}
          />
        </Modal>
      )}
    </>
  );
}
