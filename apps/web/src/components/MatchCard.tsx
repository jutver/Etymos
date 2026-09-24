import { useState } from "react";
import {
  ArrowsLeftRight,
  CaretDown,
  CheckCircle,
  GraduationCap,
  Globe,
  LockSimple,
  MagicWand,
  Quotes,
} from "@phosphor-icons/react";
import type { MatchedSource } from "@etymos/shared";
import { cn } from "@etymos/shared";
import { severityConfig } from "./Severity";
import { colorForMatch } from "../screens/Report/highlights";
import { Button } from "./ui/Button";
import { t } from "../lib/i18n";

interface MatchCardProps {
  match: MatchedSource;
  /** Zero-based position — also picks the highlight colour and the badge number. */
  index: number;
  locked?: boolean;
  rewriteLocked?: boolean;
  selected?: boolean;
  resolved?: boolean;
  /** True when this match has no highlight anywhere in the document view, so
   * selecting it can't jump to a place. Surfaced instead of a silent no-op. */
  notLocated?: boolean;
  onSelect?: (matchId: string) => void;
  onViewComparison: (match: MatchedSource) => void;
  onRewrite: (match: MatchedSource) => void;
  onCite?: (match: MatchedSource) => void;
}

/**
 * A single matched source in the report sidebar.
 *
 * Kept deliberately quiet: identity (colour swatch + number) and the essential
 * facts are always visible, while the AI explanation is one tap away behind a
 * disclosure so a document with a dozen matches still scans as a list rather
 * than a wall.
 */
export function MatchCard({
  match,
  index,
  locked = false,
  rewriteLocked = locked,
  selected = false,
  resolved = false,
  notLocated = false,
  onSelect,
  onViewComparison,
  onRewrite,
  onCite,
}: MatchCardProps) {
  const [explanationOpen, setExplanationOpen] = useState(false);
  const severity = severityConfig[match.severity];
  const color = colorForMatch(match, index);
  const explanationId = `match-explanation-${match.id}`;

  return (
    <article
      id={`match-${match.id}`}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "scroll-mt-4 rounded-[var(--radius-card)] border bg-white transition-all",
        selected
          ? "border-brand-400 shadow-[0_0_0_3px_rgba(30,79,196,0.10)]"
          : "border-line hover:border-ink-300",
        resolved && "opacity-70",
      )}
    >
      <button
        type="button"
        onClick={() => onSelect?.(match.id)}
        className="flex w-full items-start gap-2.5 rounded-t-[var(--radius-card)] px-4 pb-2 pt-3.5 text-left"
      >
        {/* Colour swatch carries the number too, so the link back to the
            document highlight never depends on colour alone. */}
        <span
          className={cn(
            "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md text-[0.625rem] font-bold tabular-nums text-white",
            color.chip,
          )}
        >
          {index + 1}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-ink-500">
            {match.sourceKind === "academic" ? <GraduationCap size={13} /> : <Globe size={13} />}
            <span className={severity.text}>{t(severity.label)}</span>
            <span aria-hidden="true">·</span>
            <span>{match.matchPercent}{t("% match")}</span>
          </span>
          <span className="mt-1 block truncate text-sm font-semibold leading-snug text-ink-900">
            {match.sourceTitle}
          </span>
          <span className="mt-0.5 block truncate text-xs text-ink-500">{match.sourceAuthor}</span>
        </span>

        {resolved && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-success-bg px-2 py-0.5 text-[0.625rem] font-bold text-success">
            <CheckCircle size={11} weight="fill" />{" "}{t("Fixed")}</span>
        )}
      </button>

      <div className="px-4 pb-3.5">
        {/* Extends the click target below the header: clicking the quoted text
            selects the match too. Pointer-only convenience — the header button
            above stays the single keyboard/screen-reader control. Dragging to
            select text to copy it must not count as a click, hence the guard. */}
        <blockquote
          onClick={() => {
            if (window.getSelection()?.toString()) return;
            onSelect?.(match.id);
          }}
          className={cn(
            "cursor-pointer rounded-lg px-3 py-2 text-xs leading-relaxed transition-[filter] hover:brightness-95",
            color.mark,
          )}
        >
          {match.userSnippet}
        </blockquote>

        {selected && notLocated && (
          <p role="status" className="mt-2 text-xs leading-relaxed text-ink-500">
            {t("Couldn't find this passage in the document text, so there's nothing to highlight.")}</p>
        )}

        {locked ? (
          <p className="mt-2.5 flex items-center gap-1.5 rounded-lg bg-surface-tint px-3 py-2 text-xs font-medium text-brand-600">
            <LockSimple size={13} weight="fill" />
            {t("Explanation available on paid plans")}</p>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setExplanationOpen((v) => !v)}
              aria-expanded={explanationOpen}
              aria-controls={explanationId}
              className="mt-2.5 flex w-full items-center justify-between gap-2 rounded-lg px-1 py-1.5 text-left text-xs font-semibold text-brand-600 transition-colors hover:bg-brand-100/50"
            >
              {t("Why this is flagged")}<CaretDown
                size={13}
                className={cn("transition-transform", explanationOpen && "rotate-180")}
              />
            </button>
            {explanationOpen && (
              <p
                id={explanationId}
                className="rounded-lg bg-brand-100/50 px-3 py-2.5 text-xs leading-relaxed text-ink-700"
              >
                {match.explanation}
              </p>
            )}
          </>
        )}

        <div className="mt-3 flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onViewComparison(match)}
            iconLeft={<ArrowsLeftRight size={14} />}
            className="h-8 px-2.5 text-xs"
          >
            {t("Compare")}</Button>
          {onCite && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onCite(match)}
              iconLeft={<Quotes size={14} />}
              className="h-8 px-2.5 text-xs"
            >
              {t("Copy Citation")}</Button>
          )}
          <Button
            size="sm"
            variant={rewriteLocked ? "outline" : "secondary"}
            onClick={() => onRewrite(match)}
            iconLeft={rewriteLocked ? <LockSimple size={12} weight="fill" /> : <MagicWand size={14} />}
            className="h-8 px-2.5 text-xs"
          >
            {t("Rewrite")}</Button>
        </div>
      </div>
    </article>
  );
}
