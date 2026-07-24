/**
 * A Google-Docs-style horizontal ruler pinned above the page stack.
 *
 * Purely decorative/alignment guide — no drag-to-adjust-margins interaction.
 * It spans exactly `width` px (the sheet width) and marks the left/right
 * margin bands so the sheet below it reads as a real page, not a floating
 * text column. Ticks are drawn every 1/16" (major every 1"), matching the
 * inch-denominated ruler word processors show.
 */

const DPI = 96;
const INCH = DPI;

interface PageRulerProps {
  /** Total ruler width in px — should match the page sheet's width. */
  width: number;
  /** Margin band width in px, mirrored on both sides. */
  margin: number;
}

export function PageRuler({ width, margin }: PageRulerProps) {
  const inches = width / INCH;
  const ticks: React.ReactNode[] = [];

  for (let i = 0; i <= inches * 16; i += 1) {
    const x = (i / 16) * INCH;
    const isInch = i % 16 === 0;
    const isHalf = i % 8 === 0;
    const isQuarter = i % 4 === 0;
    const height = isInch ? 11 : isHalf ? 8 : isQuarter ? 6 : 4;
    ticks.push(
      <div
        key={i}
        className="absolute bottom-0 w-px bg-ink-300"
        style={{ left: x, height }}
      />,
    );
    if (isInch && x > 0 && x < width) {
      ticks.push(
        <span
          key={`label-${i}`}
          className="absolute bottom-[11px] -translate-x-1/2 select-none text-[0.5625rem] font-medium tabular-nums text-ink-500"
          style={{ left: x }}
        >
          {x / INCH}
        </span>,
      );
    }
  }

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none relative mx-auto select-none"
      style={{ width }}
    >
      <div className="relative h-6 overflow-hidden rounded-t-[2px] border border-b-0 border-line/70 bg-white">
        {/* Margin bands (shaded, matching the sheet's ~1in padding). */}
        <div className="absolute inset-y-0 left-0 bg-surface-muted" style={{ width: margin }} />
        <div className="absolute inset-y-0 right-0 bg-surface-muted" style={{ width: margin }} />
        {/* Printable-area edges. */}
        <div className="absolute inset-y-0 w-px bg-brand-400" style={{ left: margin }} />
        <div className="absolute inset-y-0 w-px bg-brand-400" style={{ right: margin }} />
        {ticks}
      </div>
    </div>
  );
}
