import { ArrowSquareOut, GraduationCap } from "@phosphor-icons/react";
import type { PublishedPaperMatch } from "@etymos/shared";
import { t } from "../../lib/i18n";

export function PublishedPaperNotice({ match }: { match?: PublishedPaperMatch }) {
  if (!match?.detected) return null;

  const metaParts = [
    match.sourceAuthors.slice(0, 2).join(", "),
    match.sourceYear,
  ].filter(Boolean);
  const roundedPercent = Math.round(match.coveragePercent);

  return (
    <div
      role="status"
      aria-label={t("This document appears to be the published paper itself")}
      className="mb-3 rounded-[var(--radius-card)] border border-indigo-200 bg-indigo-50/75 p-3.5 text-left"
    >
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white">
          <GraduationCap size={15} weight="fill" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-navy-900">
            {t("This document appears to be the published paper itself")}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-ink-700">
            {t("{{percent}}% of this document matches \"{{title}}\".", {
              percent: roundedPercent,
              title: match.sourceTitle,
            })}
          </p>
          {metaParts.length > 0 && (
            <p className="mt-1 text-[11px] text-ink-500">
              {metaParts.join(" · ")}
            </p>
          )}
          {match.sourceUrl && (
            <a
              href={match.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-indigo-700 underline-offset-2 hover:underline"
            >
              {t("View published paper")}
              <ArrowSquareOut size={12} aria-hidden="true" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
