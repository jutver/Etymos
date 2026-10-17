import { List, SquaresFour } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import type { DocumentsViewMode } from "./types";
import { t, tr } from "../../lib/i18n";
import { PillIndicator, usePill } from "../../components/ui/PillIndicator";

const MODES: { value: DocumentsViewMode; label: string; icon: typeof List }[] = [
  { value: "list", label: tr("List"), icon: List },
  { value: "icon", label: tr("Icon"), icon: SquaresFour },
];

export function ViewModeToggle({
  value,
  onChange,
}: {
  value: DocumentsViewMode;
  onChange: (mode: DocumentsViewMode) => void;
}) {
  const pill = usePill<HTMLDivElement>(value);
  return (
    <div
      ref={pill.ref}
      role="tablist"
      aria-label={t("View mode")}
      className="relative inline-flex items-center gap-0.5 rounded-full border border-line bg-surface-tint p-1"
    >
      <PillIndicator box={pill.box} className="bg-white shadow-[var(--shadow-card)]" />
      {MODES.map((mode) => {
        const active = value === mode.value;
        return (
          <button
            key={mode.value}
            type="button"
            role="tab"
            aria-selected={active}
            data-pill-active={active}
            onClick={() => onChange(mode.value)}
            className={cn(
              "relative rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
              active ? "text-ink-900" : "text-ink-500 hover:text-ink-900",
            )}
          >
            <span className="relative flex items-center gap-1.5">
              <mode.icon size={15} weight={active ? "fill" : "regular"} />
              {t(mode.label)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
