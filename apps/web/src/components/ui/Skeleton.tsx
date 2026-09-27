import { cn } from "@etymos/shared";

interface SkeletonProps {
  className?: string;
  /**
   * `shimmer` sweeps a highlight across the block (uses the shared
   * `shimmer-bg` utility + `--animate-shimmer` token). `flat` is a static
   * muted block — use it when many skeletons sit together and a wall of
   * sweeping highlights would be noisy.
   */
  variant?: "shimmer" | "flat";
  /** Renders a pill instead of the default card radius. */
  rounded?: "sm" | "md" | "lg" | "full";
}

const radii: Record<NonNullable<SkeletonProps["rounded"]>, string> = {
  sm: "rounded",
  md: "rounded-[var(--radius-control)]",
  lg: "rounded-[var(--radius-card)]",
  full: "rounded-full",
};

/**
 * Content placeholder. Always pass explicit sizing via `className` so the
 * skeleton reserves the same box as the real content and the layout does not
 * shift when data lands.
 *
 * Motion is disabled under `prefers-reduced-motion`, leaving a plain muted
 * block.
 */
export function Skeleton({ className, variant = "shimmer", rounded = "sm" }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        radii[rounded],
        variant === "shimmer"
          ? "shimmer-bg animate-shimmer motion-reduce:animate-none motion-reduce:bg-surface-muted"
          : "bg-surface-muted",
        className,
      )}
    />
  );
}

interface SkeletonTextProps {
  /** Number of lines to render. */
  lines?: number;
  className?: string;
  /** Height of each line. Defaults to a body-text-ish 0.75rem bar. */
  lineClassName?: string;
}

/**
 * A stack of text-line skeletons. The last line is shortened so the block
 * reads as a paragraph rather than a solid rectangle.
 */
export function SkeletonText({ lines = 3, className, lineClassName }: SkeletonTextProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          className={cn("h-3 w-full", i === lines - 1 && "w-2/3", lineClassName)}
        />
      ))}
    </div>
  );
}

/**
 * Card-shaped placeholder: a title bar plus a few body lines inside the
 * standard card chrome. Handy for list/grid loading states.
 */
export function SkeletonCard({ className, lines = 3 }: { className?: string; lines?: number }) {
  return (
    <div
      className={cn(
        "studio-card rounded-[var(--radius-card)] border border-line bg-white p-5 shadow-[var(--shadow-card)]",
        className,
      )}
    >
      <Skeleton className="h-4 w-1/3" />
      <SkeletonText lines={lines} className="mt-4" />
    </div>
  );
}
