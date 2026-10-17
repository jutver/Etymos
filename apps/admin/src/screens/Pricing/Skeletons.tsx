import { cn } from "@etymos/shared";
import { LoadingRegion, Skeleton } from "../../components/Skeleton";

/** Grid classes by column count; spelled out so Tailwind sees them. */
const COLS: Record<number, string> = { 1: "grid-cols-1", 2: "grid-cols-2", 4: "grid-cols-4" };

/** One editable card: name, `fields` labelled inputs in `cols` columns, a button. */
function FormCardSkeleton({ fields, cols, titleWidth = "w-28" }: { fields: number; cols: number; titleWidth?: string }) {
  return (
    <div className="rounded-card border border-border bg-surface p-5 shadow-card">
      <Skeleton className={cn("h-4", titleWidth)} />
      <div className={cn("mt-3 grid gap-3", COLS[cols])}>
        {Array.from({ length: fields }, (_, i) => (
          <div key={i}>
            <Skeleton className="mb-2 h-3 w-24" />
            <Skeleton className="h-9 w-full" rounded="control" />
          </div>
        ))}
      </div>
      <Skeleton className="mt-4 h-9 w-20" rounded="control" />
    </div>
  );
}

/** Section heading, optionally with the caption under it. */
function HeadingSkeleton({ caption = false }: { caption?: boolean }) {
  return (
    <>
      <Skeleton className="h-6 w-40" rounded="control" />
      {caption && <Skeleton className="mt-2 h-3 w-[min(26rem,85%)]" />}
    </>
  );
}

/** Pricing → Plans & packs: plan cards with four fields, pack cards with two. */
export function PlansAndPacksSkeleton() {
  return (
    <LoadingRegion className="space-y-6">
      <div aria-hidden="true">
        <HeadingSkeleton />
        <div className="mt-3 space-y-3">
          {["w-20", "w-24", "w-16"].map((w) => (
            <FormCardSkeleton key={w} fields={4} cols={4} titleWidth={w} />
          ))}
        </div>
      </div>
      <div aria-hidden="true">
        <HeadingSkeleton />
        <div className="mt-3 space-y-3">
          {["w-32", "w-28"].map((w) => (
            <FormCardSkeleton key={w} fields={2} cols={2} titleWidth={w} />
          ))}
        </div>
      </div>
    </LoadingRegion>
  );
}

/** Rows of existing discounts: name, amount, schedule, then switch and delete. */
function DiscountRowsSkeleton({ count }: { count: number }) {
  return (
    <div className="divide-y divide-border rounded-card border border-border bg-surface shadow-card">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex items-center justify-between gap-4 px-5 py-4">
          <div className="min-w-0 flex-1">
            <Skeleton className={cn("h-4", i % 2 ? "w-36" : "w-48")} />
            <Skeleton className="mt-2 h-3 w-20" />
            <Skeleton className="mt-1.5 h-3 w-[min(16rem,70%)]" />
          </div>
          <div className="flex items-center gap-3">
            <Skeleton className="h-5 w-9" rounded="full" />
            <Skeleton className="h-7 w-14" rounded="control" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Pricing → Discounts: per section a create form, then the existing rows. */
export function DiscountsSkeleton() {
  return (
    <LoadingRegion className="space-y-8">
      {[4, 5].map((fields) => (
        <div key={fields} aria-hidden="true">
          <HeadingSkeleton caption />
          <div className="mt-3 space-y-4">
            <FormCardSkeleton fields={fields} cols={1} titleWidth="w-52" />
            <DiscountRowsSkeleton count={2} />
          </div>
        </div>
      ))}
    </LoadingRegion>
  );
}
