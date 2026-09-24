import { cn } from "@etymos/shared";
import { t, tr } from "../../lib/i18n";

export type SpinnerSize = "sm" | "md" | "lg";

const sizes: Record<SpinnerSize, string> = {
  sm: "size-4 border-2",
  md: "size-6 border-2",
  lg: "size-9 border-[3px]",
};

export type SpinnerTone = "brand" | "ink" | "inverse";

const tones: Record<SpinnerTone, string> = {
  brand: "border-brand-200 border-t-brand-600",
  ink: "border-line border-t-ink-500",
  inverse: "border-white/30 border-t-white",
};

interface SpinnerProps {
  size?: SpinnerSize;
  tone?: SpinnerTone;
  className?: string;
  /**
   * Accessible label. Rendered visually hidden so the spinner still announces
   * itself. Pass `null` when a sibling element already carries the live text
   * (e.g. PageLoader renders its own visible label).
   */
  label?: string | null;
}

/**
 * Indeterminate activity indicator.
 *
 * Under `prefers-reduced-motion` the rotation is dropped (the global reset in
 * globals.css already clamps animation duration; `motion-reduce:animate-none`
 * makes that explicit so the ring settles in a stable, legible position rather
 * than freezing mid-frame). The two-tone border keeps it readable as a
 * progress affordance even when static.
 */
export function Spinner({ size = "md", tone = "brand", className, label = tr("Loading") }: SpinnerProps) {
  return (
    <span
      role="status"
      className={cn(
        "inline-block shrink-0 rounded-full border-solid animate-spin motion-reduce:animate-none",
        sizes[size],
        tones[tone],
        className,
      )}
    >
      {label !== null && <span className="sr-only">{t(label)}</span>}
    </span>
  );
}
