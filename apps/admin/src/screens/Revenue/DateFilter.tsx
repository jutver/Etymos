// Date filter for the Transactions and Orders tabs: all time, one day, or a
// range of days (Vietnam time). Kept in the URL (?day= or ?from=&to=) so a
// filtered list can be linked to and survives a reload.
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { shiftDay, todayVN } from "../../lib/revenueQueries";
import type { DateMode, DateSelection } from "./dateSelection";
import { t, tr } from "../../lib/i18n";

const MODES: { value: DateMode; label: string }[] = [
  { value: "all", label: tr("All time") },
  { value: "day", label: tr("Day") },
  { value: "range", label: tr("Range") },
];

const inputClass = "bg-transparent text-caption text-fg outline-none";

export function DateFilter({ value, onChange }: { value: DateSelection; onChange: (next: DateSelection) => void }) {
  const today = todayVN();

  function setMode(mode: DateMode) {
    if (mode === value.mode) return;
    if (mode === "all") onChange({ mode, span: null });
    // Keep what was picked where it fits; otherwise start from today, or
    // from the 1st of this month for a range.
    else if (mode === "day") onChange({ mode, span: { start: value.span?.end ?? today, end: value.span?.end ?? today } });
    else onChange({ mode, span: value.span ?? { start: `${today.slice(0, 7)}-01`, end: today } });
  }

  const span = value.span;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-0.5 rounded-card border border-border bg-surface p-1 shadow-card">
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            aria-pressed={value.mode === m.value}
            onClick={() => setMode(m.value)}
            className={cn(
              "rounded-md px-3 py-1.5 text-caption font-medium transition-colors",
              value.mode === m.value ? "bg-accent-bg text-accent" : "text-fg-muted hover:text-fg",
            )}
          >
            {t(m.label)}
          </button>
        ))}
      </div>

      {value.mode === "day" && span && (
        <div className="flex items-center gap-1 rounded-card border border-border bg-surface px-1.5 py-1 shadow-card">
          <button
            type="button"
            title={t("Previous day")}
            aria-label={t("Previous day")}
            onClick={() => {
              const day = shiftDay(span.start, -1);
              onChange({ mode: "day", span: { start: day, end: day } });
            }}
            className="flex size-7 items-center justify-center rounded-md text-fg-muted transition hover:bg-surface-raised hover:text-fg"
          >
            <CaretLeft size={14} weight="bold" />
          </button>
          <input
            type="date"
            value={span.start}
            max={today}
            onChange={(e) => e.target.value && onChange({ mode: "day", span: { start: e.target.value, end: e.target.value } })}
            className={inputClass}
            aria-label={t("Day")}
          />
          <button
            type="button"
            title={t("Next day")}
            aria-label={t("Next day")}
            disabled={span.start >= today}
            onClick={() => {
              const day = shiftDay(span.start, 1);
              onChange({ mode: "day", span: { start: day, end: day } });
            }}
            className="flex size-7 items-center justify-center rounded-md text-fg-muted transition hover:bg-surface-raised hover:text-fg disabled:pointer-events-none disabled:opacity-40"
          >
            <CaretRight size={14} weight="bold" />
          </button>
        </div>
      )}

      {value.mode === "range" && span && (
        <div className="flex items-center gap-2 rounded-card border border-border bg-surface px-3 py-1.5 shadow-card">
          <input
            type="date"
            value={span.start}
            max={span.end}
            onChange={(e) =>
              e.target.value &&
              onChange({ mode: "range", span: { start: e.target.value, end: span.end < e.target.value ? e.target.value : span.end } })
            }
            className={inputClass}
            aria-label={t("Start date")}
          />
          <span className="text-fg-subtle">–</span>
          <input
            type="date"
            value={span.end}
            min={span.start}
            max={today}
            onChange={(e) =>
              e.target.value &&
              onChange({ mode: "range", span: { start: span.start > e.target.value ? e.target.value : span.start, end: e.target.value } })
            }
            className={inputClass}
            aria-label={t("End date")}
          />
        </div>
      )}
    </div>
  );
}
