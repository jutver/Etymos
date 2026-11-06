import { m, useReducedMotion } from "motion/react";
import { cn } from "@etymos/shared";
import { isCheckPoint, pointLabel, type TimelinePoint } from "./versionTimeline";

export type ChartSpacing = "order" | "date";

// Switching "In order" / "By date" glides the dots, ticks and lines to their
// new places instead of jumping. Same curve as the auth card.
const GLIDE = { duration: 0.5, ease: [0.22, 1, 0.36, 1] } as const;
const GLIDE_CSS = "transition-[left,top,width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none";

/** Where each point sits across the chart, 0..1. "date" falls back to even
 * spacing when any point has no time or they all share one. */
function xPositions(points: TimelinePoint[], spacing: ChartSpacing): number[] {
  const n = points.length;
  const even = points.map((_, i) => (n <= 1 ? 0.5 : i / (n - 1)));
  if (spacing === "order") return even;
  const times = points.map((p) => (p.at ? Date.parse(p.at) : NaN));
  if (times.some(Number.isNaN)) return even;
  const lo = Math.min(...times);
  const hi = Math.max(...times);
  if (hi === lo) return even;
  return times.map((time) => (time - lo) / (hi - lo));
}

/** A rounded top for the Y axis, so a 14% → 32% history isn't squashed flat. */
function niceMax(max: number): number {
  // A multiple of 20, so the quarter gridlines land on whole numbers.
  return Math.min(100, Math.max(20, Math.ceil((max * 1.15) / 20) * 20));
}

/** Breaks a line at points without a value (AI before detection existed). */
function segments(xs: number[], ys: (number | null)[]): string[] {
  const out: string[] = [];
  let current: string[] = [];
  ys.forEach((y, i) => {
    if (y === null) {
      if (current.length) out.push(current.join(" "));
      current = [];
      return;
    }
    current.push(`${xs[i] * 100},${y}`);
  });
  if (current.length) out.push(current.join(" "));
  return out;
}

/**
 * Similarity (and AI-writing) score across a document's checks, with saved
 * drafts as ticks along the bottom. Inline SVG, no chart library: lines are
 * drawn in a 0..100 box that stretches to the container, and the dots are
 * positioned over it in percentages so they stay round.
 *
 * `compact` is the Version History sparkline (no axis, not interactive).
 */
export function ScoreChart({
  points,
  showAi,
  compact = false,
  spacing = "order",
  selectedId = null,
  onSelect,
}: {
  points: TimelinePoint[];
  showAi: boolean;
  compact?: boolean;
  spacing?: ChartSpacing;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
}) {
  const reduceMotion = useReducedMotion();
  const glide = reduceMotion ? { duration: 0 } : GLIDE;
  const checks = points.filter(isCheckPoint);
  const values = checks.flatMap((p) => (showAi && p.ai !== null ? [p.similarity!, p.ai] : [p.similarity!]));
  const xs = xPositions(points, spacing);

  // The sparkline zooms in on the scores' own range; the full chart starts at 0.
  const top = compact ? Math.max(...values) + 4 : niceMax(Math.max(...values, 0));
  const bottom = compact ? Math.max(0, Math.min(...values) - 4) : 0;
  const y = (v: number | null) => (v === null ? null : 100 - ((v - bottom) / (top - bottom || 1)) * 100);

  const simY = points.map((p) => y(p.similarity));
  // AI lines skip drafts as well as checks without an AI score.
  const aiY = points.map((p) => (isCheckPoint(p) ? y(p.ai) : null));
  const isCheck = points.map(isCheckPoint);
  const checkXs = xs.filter((_, i) => isCheck[i]);
  const simPolyline = segments(checkXs, checks.map((p) => y(p.similarity)));
  const aiPolyline = showAi ? segments(checkXs, aiY.filter((_, i) => isCheck[i])) : [];

  const grid = compact ? [] : [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(top * f));

  return (
    <div className={cn("relative", compact ? "h-16" : "h-56 sm:h-64")}>
      {/* Plot box: room for the Y labels and the draft ticks. */}
      <div className={cn("absolute", compact ? "inset-x-2 bottom-3 top-1.5" : "bottom-6 left-9 right-3 top-3")}>
        {grid.map((g) => (
          <div key={g} className="absolute inset-x-0 border-t border-dashed border-line" style={{ top: `${y(g)}%` }}>
            <span className="absolute -left-9 -top-2 w-7 text-right text-micro tabular-nums text-ink-400">{g}%</span>
          </div>
        ))}

        <svg className="absolute inset-0 size-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {aiPolyline.map((pts, i) => (
            <m.polyline
              key={`ai-${i}`}
              initial={false}
              animate={{ points: pts }}
              transition={glide}
              fill="none"
              stroke="var(--color-navy-700)"
              strokeOpacity={0.55}
              strokeWidth={compact ? 1.25 : 1.75}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {simPolyline.map((pts, i) => (
            <m.polyline
              key={`sim-${i}`}
              initial={false}
              animate={{ points: pts }}
              transition={glide}
              fill="none"
              stroke="var(--color-brand-600)"
              strokeWidth={compact ? 1.75 : 2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>

        {points.map((p, i) => {
          const left = `${xs[i] * 100}%`;
          const selected = p.id === selectedId;
          if (!isCheckPoint(p)) {
            // A saved draft: a tick on the baseline, between the checks it came after.
            return (
              <span
                key={p.id}
                aria-hidden="true"
                className={cn(
                  "absolute -translate-x-1/2 rounded-full",
                  GLIDE_CSS,
                  compact ? "-bottom-2.5 h-1.5 w-0.5 bg-ink-300" : "-bottom-5 h-2.5 w-1",
                  !compact && (selected ? "bg-brand-500" : "bg-ink-300"),
                )}
                style={{ left }}
              />
            );
          }
          const dotTop = `${simY[i]}%`;
          const aiTop = showAi && aiY[i] !== null ? `${aiY[i]}%` : null;
          return (
            <span key={p.id}>
              {aiTop && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-navy-700/60 bg-white",
                    GLIDE_CSS,
                    compact ? "size-1.5 border" : "size-2.5",
                  )}
                  style={{ left, top: aiTop }}
                />
              )}
              <span
                aria-hidden="true"
                className={cn(
                  "absolute -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-600 ring-white",
                  GLIDE_CSS,
                  compact ? "size-1.5 ring-1" : "size-3 ring-2",
                  selected && "ring-4 ring-brand-200",
                )}
                style={{ left, top: dotTop }}
              />
            </span>
          );
        })}

        {/* Hit areas: one column per point, so a tap anywhere above a draft or
            check selects it. Kept out of the sparkline, which isn't interactive. */}
        {!compact && onSelect && (
          <div className="absolute -bottom-6 inset-x-0 top-0">
            {points.map((p, i) => {
              const prev = i === 0 ? 0 : (xs[i - 1] + xs[i]) / 2;
              const next = i === points.length - 1 ? 1 : (xs[i] + xs[i + 1]) / 2;
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={p.id === selectedId}
                  aria-label={pointLabel(p, showAi)}
                  onClick={() => onSelect(p.id)}
                  onMouseEnter={() => onSelect(p.id)}
                  onFocus={() => onSelect(p.id)}
                  className={cn("absolute inset-y-0 rounded-sm focus-visible:outline-2 focus-visible:outline-brand-500", GLIDE_CSS)}
                                    style={{ left: `${prev * 100}%`, width: `${(next - prev) * 100}%` }}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
