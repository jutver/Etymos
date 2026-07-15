import { cn } from "@etymos/shared";

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  icon?: React.ReactNode;
}

export function Toggle({ checked, onChange, label, description, icon }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-3 rounded-[var(--radius-control)] border border-line bg-white px-4 py-3 text-left transition-colors hover:border-brand-300"
    >
      <div className="flex items-center gap-3">
        {icon && <span className="text-ink-500">{icon}</span>}
        <div>
          <p className="text-sm font-semibold text-ink-900">{label}</p>
          {description && <p className="text-xs text-ink-500">{description}</p>}
        </div>
      </div>
      <span
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
          checked ? "bg-brand-500" : "bg-ink-300/50",
        )}
      >
        <span
          className={cn(
            "inline-block size-4.5 transform rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-[1.375rem]" : "translate-x-1",
          )}
        />
      </span>
    </button>
  );
}
