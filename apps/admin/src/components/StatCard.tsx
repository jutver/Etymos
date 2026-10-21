import type { Icon } from "@phosphor-icons/react";
import { t } from "../lib/i18n";

interface StatCardProps {
  label: string;
  value: string;
  icon: Icon;
  /** A small line under the value. */
  hint?: string;
}

export function StatCard({ label, value, icon: IconComponent, hint }: StatCardProps) {
  return (
    <div className="rounded-card border border-border bg-surface p-5 shadow-card">
      <div className="flex items-center justify-between">
        <span className="text-caption font-medium text-fg-muted">{t(label)}</span>
        <IconComponent size={16} weight="bold" className="text-fg-subtle" />
      </div>
      <p className="mt-2 font-mono text-h1 font-semibold text-fg">{value}</p>
      {hint && <p className="mt-1 text-caption text-fg-muted">{hint}</p>}
    </div>
  );
}
