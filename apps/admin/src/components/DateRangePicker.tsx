import { cn } from "@etymos/shared";
import { presetRange, type DateRange, type DateRangePreset } from "../lib/dashboardQueries";
import { t } from "../lib/i18n";

const PRESETS: { value: Exclude<DateRangePreset, "custom">; label: string }[] = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "1y", label: "1y" },
];

const TODAY = new Date().toISOString().slice(0, 10);

interface DateRangePickerProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
}

export function DateRangePicker({ value, onChange }: DateRangePickerProps) {
  function handlePreset(preset: Exclude<DateRangePreset, "custom">) {
    onChange(presetRange(preset));
  }

  function handleCustomStart(start: string) {
    if (!start) return;
    onChange({ preset: "custom", start, end: value.end < start ? start : value.end });
  }

  function handleCustomEnd(end: string) {
    if (!end) return;
    onChange({ preset: "custom", start: value.start > end ? end : value.start, end });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-0.5 rounded-card border border-border bg-surface p-1 shadow-card">
        {PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => handlePreset(p.value)}
            className={cn(
              "rounded-md px-3 py-1.5 text-caption font-medium transition-colors",
              value.preset === p.value ? "bg-accent-bg text-accent" : "text-fg-muted hover:text-fg",
            )}
          >
            {t(p.label)}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onChange({ preset: "custom", start: value.start, end: value.end })}
          className={cn(
            "rounded-md px-3 py-1.5 text-caption font-medium transition-colors",
            value.preset === "custom" ? "bg-accent-bg text-accent" : "text-fg-muted hover:text-fg",
          )}
        >
          {t("Custom")}</button>
      </div>

      {value.preset === "custom" && (
        <div className="flex items-center gap-2 rounded-card border border-border bg-surface px-3 py-1.5 shadow-card">
          <input
            type="date"
            value={value.start}
            max={value.end}
            onChange={(e) => handleCustomStart(e.target.value)}
            className="bg-transparent text-caption text-fg outline-none"
            aria-label={t("Start date")}
          />
          <span className="text-fg-subtle">–</span>
          <input
            type="date"
            value={value.end}
            min={value.start}
            max={TODAY}
            onChange={(e) => handleCustomEnd(e.target.value)}
            className="bg-transparent text-caption text-fg outline-none"
            aria-label={t("End date")}
          />
        </div>
      )}
    </div>
  );
}
