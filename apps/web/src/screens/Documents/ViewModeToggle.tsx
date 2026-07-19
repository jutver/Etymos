import { List, SquaresFour } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import type { DocumentsViewMode } from "./types";

const MODES: { value: DocumentsViewMode; label: string; icon: typeof List }[] = [
  { value: "list", label: "List", icon: List },
  { value: "icon", label: "Icon", icon: SquaresFour },
];

export function ViewModeToggle({
  value,
  onChange,
}: {
  value: DocumentsViewMode;
  onChange: (mode: DocumentsViewMode) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="View mode"
      className="inline-flex items-center gap-0.5 rounded-full border border-line bg-surface-tint p-1"
    >
      {MODES.map((mode) => {
        const active = value === mode.value;
        return (
          <button
            key={mode.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(mode.value)}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-white text-ink-900 shadow-[var(--shadow-card)]"
                : "text-ink-500 hover:text-ink-900",
            )}
          >
            <mode.icon size={15} weight={active ? "fill" : "regular"} />
            {mode.label}
          </button>
        );
      })}
    </div>
  );
}
