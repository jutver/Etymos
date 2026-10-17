import type { ReactNode } from "react";
import { cn } from "@etymos/shared";
import { t } from "../lib/i18n";

/**
 * Loading placeholder. Size it with `className` to match the content it
 * stands in for, so nothing shifts when the data lands. The shimmer stops
 * under prefers-reduced-motion (globals.css).
 */
export function Skeleton({ className, rounded = "sm" }: { className?: string; rounded?: "sm" | "control" | "full" }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "shimmer-bg animate-shimmer",
        rounded === "full" ? "rounded-full" : rounded === "control" ? "rounded-control" : "rounded",
        className,
      )}
    />
  );
}

/** Lines of text; the last is shorter so the block reads as a paragraph. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        // cn() doesn't merge Tailwind classes, so pick one width rather than override it.
        <Skeleton key={i} className={cn("h-3", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

/** Wraps a skeleton so screen readers hear "Loading…" once instead of nothing. */
export function LoadingRegion({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">{t("Loading…")}</span>
      {children}
    </div>
  );
}

/**
 * A detail page (Users → user, Moderation → document) while it loads: back
 * link, title with badges, the line under it, then one card per entry in
 * `cards` with that many form fields.
 */
export function DetailPageSkeleton({ cards }: { cards: number[] }) {
  return (
    <LoadingRegion className="max-w-2xl">
      <Skeleton className="mb-4 h-3.5 w-28" />
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-8 w-[min(20rem,70%)]" rounded="control" />
        <Skeleton className="h-6 w-16" rounded="full" />
        <Skeleton className="h-6 w-20" rounded="full" />
      </div>
      <Skeleton className="mt-2.5 h-3.5 w-[min(28rem,90%)]" />
      {cards.map((fields, i) => (
        <div key={i} aria-hidden="true" className="mt-6 rounded-card border border-border bg-surface p-6 shadow-card">
          <Skeleton className="h-5 w-36" rounded="control" />
          <div className="mt-5 grid grid-cols-2 gap-4">
            {Array.from({ length: fields }, (_, f) => (
              <div key={f}>
                <Skeleton className="mb-2 h-3 w-20" />
                <Skeleton className="h-9 w-full" rounded="control" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </LoadingRegion>
  );
}

/** Rows of a list inside a card (audit trail, usage log) while they load. */
export function ListItemsSkeleton({ count = 3 }: { count?: number }) {
  return (
    <LoadingRegion>
      <ul className="space-y-3" aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <li key={i} className="rounded-control border border-border bg-surface-muted/60 p-3">
            <div className="flex items-center justify-between gap-3">
              <Skeleton className={cn("h-3.5", i % 2 ? "w-32" : "w-44")} />
              <Skeleton className="h-3 w-28" />
            </div>
            <Skeleton className={cn("mt-2 h-3", i % 2 ? "w-1/2" : "w-2/3")} />
          </li>
        ))}
      </ul>
    </LoadingRegion>
  );
}
