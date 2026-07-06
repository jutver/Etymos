import { GraduationCap, Globe, ArrowsLeftRight, MagicWand, LockSimple } from "@phosphor-icons/react";
import type { MatchedSource } from "../lib/types";
import { severityConfig } from "./Severity";
import { Button } from "./ui/Button";
import { cn } from "../lib/cn";

interface MatchCardProps {
  match: MatchedSource;
  index: number;
  locked?: boolean;
  highlighted?: boolean;
  onViewComparison: (match: MatchedSource) => void;
  onRewrite: (match: MatchedSource) => void;
}

export function MatchCard({
  match,
  index,
  locked = false,
  highlighted = false,
  onViewComparison,
  onRewrite,
}: MatchCardProps) {
  const c = severityConfig[match.severity];

  return (
    <div
      id={`match-${match.id}`}
      className={cn(
        "scroll-mt-24 rounded-[var(--radius-card)] border bg-white p-5 transition-shadow",
        highlighted ? "border-brand-400 shadow-[0_0_0_3px_rgba(30,79,196,0.12)]" : "border-line",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-muted text-xs font-bold text-ink-500">
            {index}
          </span>
          <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold", c.text, c.bg)}>
            <span className={cn("size-1.5 rounded-full", c.dot)} />
            {match.matchPercent}% match
          </span>
        </div>
        {match.sourceKind === "academic" ? (
          <span className="flex items-center gap-1 text-xs font-medium text-ink-500">
            <GraduationCap size={14} /> Academic
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs font-medium text-ink-500">
            <Globe size={14} /> Web
          </span>
        )}
      </div>

      <p className="mt-3 text-sm font-semibold leading-snug text-ink-900">{match.sourceTitle}</p>
      <p className="mt-0.5 text-xs text-ink-500">{match.sourceAuthor} · {match.citation}</p>

      <blockquote className="mt-3 rounded-lg border-l-2 border-line bg-surface-tint px-3 py-2 text-xs leading-relaxed text-ink-700">
        “{match.userSnippet}”
      </blockquote>

      {locked ? (
        <div className="relative mt-3 overflow-hidden rounded-lg">
          <p className="select-none rounded-lg bg-surface-tint px-3 py-3 text-xs leading-relaxed text-ink-500 blur-[3px]">
            {match.explanation}
          </p>
          <div className="absolute inset-0 flex items-center justify-center gap-1.5 bg-white/50 text-xs font-semibold text-brand-600">
            <LockSimple size={13} weight="fill" />
            Explanation locked
          </div>
        </div>
      ) : (
        <div className="mt-3 rounded-lg bg-brand-100/50 px-3 py-2.5">
          <p className="text-[0.6875rem] font-bold uppercase tracking-wide text-brand-600">
            Why this is flagged
          </p>
          <p className="mt-1 text-xs leading-relaxed text-ink-700">{match.explanation}</p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => onViewComparison(match)} iconLeft={<ArrowsLeftRight size={15} />}>
          View source
        </Button>
        <Button
          size="sm"
          variant={locked ? "outline" : "secondary"}
          onClick={() => onRewrite(match)}
          iconLeft={locked ? <LockSimple size={13} weight="fill" /> : <MagicWand size={15} />}
        >
          Rewrite with AI
        </Button>
      </div>
    </div>
  );
}
