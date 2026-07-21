// Status indicator for a document whose check hasn't produced a similarity
// score yet. Lives here (rather than in components/Severity.tsx alongside
// StatusPill) because it describes the *job* lifecycle, not the similarity
// severity, and because Documents, History and their sub-views are the only
// screens that list unsettled checks. History imports it from here.
import { CircleNotch, WarningCircle } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import type { CheckState } from "../../lib/documentsQueries";

interface CheckStatePillProps {
  state: CheckState;
  className?: string;
}

/** Renders nothing for settled checks — callers show the normal StatusPill. */
export function CheckStatePill({ state, className }: CheckStatePillProps) {
  if (state === "completed") return null;

  if (state === "failed") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-severity-high-line bg-severity-high-bg px-2.5 py-1 text-xs font-semibold text-severity-high",
          className,
        )}
      >
        <WarningCircle size={13} weight="fill" />
        Interrupted
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-brand-300 bg-brand-100/60 px-2.5 py-1 text-xs font-semibold text-brand-700",
        className,
      )}
      role="status"
    >
      <CircleNotch size={13} className="animate-spin motion-reduce:animate-none" aria-hidden />
      Checking
    </span>
  );
}
