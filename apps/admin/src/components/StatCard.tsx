import type { Icon } from "@phosphor-icons/react";

interface StatCardProps {
  label: string;
  value: string;
  icon: Icon;
}

export function StatCard({ label, value, icon: IconComponent }: StatCardProps) {
  return (
    <div className="rounded-card border border-border bg-surface p-5 shadow-card">
      <div className="flex items-center justify-between">
        <span className="text-caption font-medium text-fg-muted">{label}</span>
        <IconComponent size={16} weight="bold" className="text-fg-subtle" />
      </div>
      <p className="mt-2 font-mono text-h1 font-semibold text-fg">{value}</p>
    </div>
  );
}
