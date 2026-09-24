import { cn } from "@etymos/shared";
import { t, currentLocale } from "../../lib/i18n";

export interface WordCountPillProps {
  words: number;
  characters: number;
  page: number;
  pageCount: number;
  dirty: boolean;
  locked: boolean;
}

/** Floating document stats, bottom-left — Word's status bar, made small. */
export function WordCountPill({
  words,
  characters,
  page,
  pageCount,
  dirty,
  locked,
}: WordCountPillProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute bottom-4 left-4 z-10 flex items-center gap-2.5 rounded-full border border-line/80 bg-white/90 px-3.5 py-1.5 text-xs font-medium text-ink-500 shadow-[var(--shadow-card)] backdrop-blur-md"
    >
      <span className="tabular-nums text-ink-900">
        <span className="font-semibold">{words.toLocaleString(currentLocale())}</span>{" "}{t("words")}</span>
      <span aria-hidden="true" className="h-3 w-px bg-line" />
      <span className="hidden tabular-nums sm:inline">{characters.toLocaleString(currentLocale())}{" "}{t("chars")}</span>
      <span aria-hidden="true" className="hidden h-3 w-px bg-line sm:block" />
      <span className="tabular-nums">
        {t("Page {{page}} of {{count}}", { page, count: pageCount })}
      </span>
      <span aria-hidden="true" className="h-3 w-px bg-line" />
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 rounded-full",
            locked ? "bg-ink-300" : dirty ? "bg-severity-moderate" : "bg-success",
          )}
        />
        {locked ? t("Reading") : dirty ? t("Unsaved") : t("Saved")}
      </span>
    </div>
  );
}
