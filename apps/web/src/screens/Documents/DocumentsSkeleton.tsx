import { cn } from "@etymos/shared";
import { Skeleton } from "../../components/ui/Skeleton";
import { t } from "../../lib/i18n";
import type { DocumentsViewMode } from "./types";

/** Title widths for the placeholder rows, so they read as different documents. */
const DOC_TITLES = ["w-[52%]", "w-[38%]", "w-[60%]", "w-[44%]"];

/**
 * Stand-in for the Documents list or grid while the first load runs. Shaped
 * like the real thing (the Default project open with a few files under it, or
 * a grid of tiles) so the page doesn't jump when the documents arrive.
 */
export function DocumentsSkeleton({ viewMode }: { viewMode: DocumentsViewMode }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{t("Loading documents…")}</span>
      {viewMode === "list" ? <ListSkeleton /> : <IconSkeleton />}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div aria-hidden="true" className="studio-card divide-y divide-line overflow-hidden rounded-[var(--radius-card-lg)] border border-line bg-white">
      {/* "Create project" */}
      <div className="flex items-center gap-3 px-4 py-3.5">
        <Skeleton rounded="md" className="size-8 shrink-0" />
        <Skeleton className="h-3.5 w-28" />
      </div>

      {/* Default project, open */}
      <div>
        <ProjectRowSkeleton nameWidth="w-20" />
        <div className="border-t border-line bg-surface-tint/50">
          {DOC_TITLES.map((width, i) => (
            <div key={i} className="flex items-center gap-3 border-t border-line/60 py-3 pl-16 pr-4 first:border-t-0">
              <Skeleton className="size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <Skeleton className={cn("h-3.5 max-w-full", width)} />
              </div>
              <Skeleton className="hidden h-3 w-16 shrink-0 sm:block" />
              <Skeleton className="hidden h-3 w-8 shrink-0 sm:block" />
              <Skeleton rounded="full" className="h-6 w-20 shrink-0" />
            </div>
          ))}
        </div>
      </div>

      <ProjectRowSkeleton nameWidth="w-32" />
    </div>
  );
}

function ProjectRowSkeleton({ nameWidth }: { nameWidth: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <span className="inline-block size-[13px] shrink-0" />
      <Skeleton rounded="md" className="size-8 shrink-0" />
      <Skeleton className={cn("h-3.5", nameWidth)} />
      <Skeleton className="h-3 w-16" />
    </div>
  );
}

/** One full row of tiles at each breakpoint (2, 3, 4, then 5 columns), never
 * a ragged second row. One class per tile, since cn() doesn't merge. */
const TILE_VISIBILITY = ["flex", "flex", "hidden sm:flex", "hidden md:flex", "hidden lg:flex"];

function IconSkeleton() {
  return (
    <div aria-hidden="true" className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      {Array.from({ length: 5 }, (_, i) => (
        <div
          key={i}
          className={cn(
            "studio-card aspect-square flex-col items-center justify-center gap-2 rounded-[var(--radius-card-lg)] border border-line bg-white p-4",
            TILE_VISIBILITY[i],
          )}
        >
          <Skeleton rounded="lg" className="size-12" />
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-2.5 w-1/3" />
        </div>
      ))}
    </div>
  );
}
