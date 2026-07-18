import type { ReactNode } from "react";

interface ChartCardProps {
  title: string;
  children: ReactNode;
  empty?: boolean;
}

export function ChartCard({ title, children, empty }: ChartCardProps) {
  return (
    <div className="rounded-card border border-border bg-surface p-5 shadow-card">
      <h3 className="text-caption font-medium text-fg-muted">{title}</h3>
      <div className="mt-3 h-56">
        {empty ? (
          <div className="flex h-full items-center justify-center text-caption text-fg-subtle">
            No data yet.
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

export const CHART_TOOLTIP_STYLE = {
  contentStyle: {
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: 8,
    fontSize: 12,
    color: "var(--color-fg)",
  },
  labelStyle: { color: "var(--color-fg-muted)" },
};

export const CHART_AXIS_PROPS = {
  stroke: "var(--color-fg-subtle)",
  fontSize: 11,
  tickLine: false,
  axisLine: { stroke: "var(--color-border)" },
};

export const CHART_COLORS = [
  "var(--color-accent)",
  "var(--color-info)",
  "var(--color-warning)",
  "var(--color-destructive)",
];
