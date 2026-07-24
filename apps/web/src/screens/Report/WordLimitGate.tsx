import { LockSimple } from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";

export interface WordLimitGateProps {
  wordLimit: number;
  onUnlock: () => void;
}

/**
 * Blurred paywall strip covering the tail of the report (either view mode)
 * once the document's word count exceeds the caller's plan word limit.
 * Absolutely positioned over the bottom of whichever view is active — the
 * parent just needs `position: relative` on that container.
 */
export function WordLimitGate({ wordLimit, onUnlock }: WordLimitGateProps) {
  return (
    <div
      aria-hidden={false}
      className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex h-[38%] min-h-48 flex-col items-center justify-end bg-gradient-to-b from-transparent via-surface-muted/85 to-surface-muted pb-8 backdrop-blur-[3px]"
    >
      <div className="pointer-events-auto mx-4 flex max-w-sm flex-col items-center rounded-[var(--radius-card-lg)] border border-line bg-white px-6 py-5 text-center shadow-[var(--shadow-pop)]">
        <div className="flex size-10 items-center justify-center rounded-full bg-severity-moderate-bg text-severity-moderate">
          <LockSimple size={18} weight="fill" />
        </div>
        <p className="mt-3 text-sm font-semibold text-navy-900">
          This document exceeds your {wordLimit.toLocaleString()}-word limit
        </p>
        <p className="mt-1 text-xs text-ink-500">
          Upgrade your plan or use a credit to view and edit the rest of this report.
        </p>
        <Button size="sm" className="mt-4" onClick={onUnlock}>
          Upgrade or use a credit
        </Button>
      </div>
    </div>
  );
}
