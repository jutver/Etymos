import { useEffect, useState } from "react";
import { cn } from "@etymos/shared";
import { Spinner } from "./Spinner";
import { t as tl, tr } from "../../lib/i18n";

interface PageLoaderProps {
  /** Visible message. Keep it short — this is a transient state. */
  label?: string;
  /**
   * Milliseconds to wait before showing anything. Prevents a loader flash on
   * fast route transitions / warm caches. Pass 0 to render immediately.
   */
  delayMs?: number;
  /**
   * `page` fills the viewport minus the nav, for route-level Suspense.
   * `inline` fills its parent — use it inside a card or panel.
   */
  fill?: "page" | "inline";
  className?: string;
}

/**
 * Full-page loading state, designed as the Suspense fallback for lazily
 * loaded routes.
 *
 * It is deliberately quiet: a single spinner and a label on the ambient
 * surface, no card chrome, so it reads as "the page is on its way" rather
 * than as content in its own right. The `delayMs` guard means a route that
 * resolves quickly never flashes a loader at all.
 */
export function PageLoader({
  label = tr("Loading"),
  delayMs = 150,
  fill = "page",
  className,
}: PageLoaderProps) {
  const [visible, setVisible] = useState(delayMs === 0);

  useEffect(() => {
    if (delayMs === 0) return;
    const t = window.setTimeout(() => setVisible(true), delayMs);
    return () => window.clearTimeout(t);
  }, [delayMs]);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn(
        "flex w-full flex-col items-center justify-center gap-4 px-5",
        fill === "page" ? "min-h-[60dvh] py-20" : "min-h-40 py-10",
        // Fade in rather than pop, and only once the delay has elapsed.
        "transition-opacity duration-200 motion-reduce:transition-none",
        visible ? "opacity-100" : "opacity-0",
        className,
      )}
    >
      <Spinner size="lg" label={null} />
      <p className="text-caption font-medium text-ink-500">{tl(label)}</p>
    </div>
  );
}
