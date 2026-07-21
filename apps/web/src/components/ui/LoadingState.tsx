import { cn } from "@etymos/shared";
import { Spinner } from "./Spinner";

interface LoadingStateProps {
  /** Short message describing what is being fetched. */
  label?: string;
  /** Optional second line for slow operations. */
  hint?: string;
  className?: string;
}

/**
 * Compact in-panel loading state, for regions that are waiting on data but
 * whose shape is unknown (so a Skeleton would be guesswork).
 *
 * When you *do* know the shape of the incoming content, prefer `Skeleton` /
 * `SkeletonCard` — a placeholder that matches the final layout avoids the
 * content jump that a centred spinner causes.
 */
export function LoadingState({ label = "Loading", hint, className }: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn("flex flex-col items-center justify-center gap-3 px-5 py-10 text-center", className)}
    >
      <Spinner label={null} />
      <div>
        <p className="text-caption font-medium text-ink-700">{label}</p>
        {hint && <p className="mt-1 text-micro text-ink-500">{hint}</p>}
      </div>
    </div>
  );
}
