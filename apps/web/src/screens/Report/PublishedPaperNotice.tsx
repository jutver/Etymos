import { ArrowSquareOut, GraduationCap } from "@phosphor-icons/react";
import { cn, type PublishedPaperMatch } from "@etymos/shared";
import { t } from "../../lib/i18n";
import { sanitizeSourceTitle } from "../../lib/sourceTitle";

export function PublishedPaperNotice({
  match,
  className,
}: {
  match?: PublishedPaperMatch;
  className?: string;
}) {
  if (!match?.detected) return null;

  const cleanTitle = sanitizeSourceTitle(match.sourceTitle, { isAcademic: true }) || match.sourceTitle;
  const metaText = [match.sourceAuthors.slice(0, 2).join(", "), match.sourceYear]
    .filter(Boolean)
    .join(" · ");
  const roundedPercent = Math.round(match.coveragePercent);

  return (
    <div
      role="status"
      aria-label={t("Published paper match")}
      className={cn(
        "mb-3 rounded-[var(--radius-card)] border border-brand-200 bg-brand-100/50 p-3 text-left dark:border-brand-500/30 dark:bg-brand-500/10",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] font-semibold text-brand-700 dark:text-brand-300">
          <GraduationCap
            size={14}
            weight="fill"
            aria-hidden="true"
            className="shrink-0 text-brand-600 dark:text-brand-400"
          />
          <span className="truncate">{t("Published paper match")}</span>
        </span>
        <span className="shrink-0 rounded-full bg-brand-200/70 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-brand-700 dark:bg-brand-500/20 dark:text-brand-300">
          {roundedPercent}
          {t("% match")}
        </span>
      </div>

      <p
        title={cleanTitle}
        className="mt-1.5 line-clamp-2 text-xs font-semibold leading-snug text-ink-900"
      >
        {cleanTitle}
      </p>

      {(metaText || match.sourceUrl) && (
        <div className="mt-1.5 flex items-center justify-between gap-2">
          {metaText ? (
            <p className="min-w-0 truncate text-[11px] text-ink-500">{metaText}</p>
          ) : (
            <span />
          )}
          {match.sourceUrl && (
            <a
              href={match.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-brand-600 underline-offset-2 hover:underline dark:text-brand-400"
            >
              {t("View paper")}
              <ArrowSquareOut size={12} aria-hidden="true" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}
