import { Fragment } from "react";
import { cn } from "@etymos/shared";
import { LoadingRegion, Skeleton } from "../../components/Skeleton";

const LOGGER_WIDTHS = ["w-20", "w-24", "w-16", "w-28"];
const MESSAGE_WIDTHS = ["w-3/5", "w-2/5", "w-4/5", "w-1/2", "w-3/4", "w-2/3", "w-1/3"];

const FILE_TITLE_WIDTHS = ["w-12", "w-24", "w-28", "w-28", "w-16", "w-24"];
const FILE_LINE_WIDTHS = ["w-11/12", "w-4/5", "w-2/3", "w-5/6", "w-1/2", "w-3/4", "w-10/12", "w-3/5"];

const ACTION_TEXT_WIDTHS = ["w-3/4", "w-2/3", "w-4/5", "w-1/2"];

/** Live log console rows on bg-navy-900 while the first poll is in flight. */
export function LiveLogRowsSkeleton({ count = 14 }: { count?: number }) {
  return (
    <LoadingRegion className="divide-y divide-white/5">
      <div aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="flex items-center gap-2 px-3 py-1.5">
            <Skeleton surface="dark" className="h-3 w-[4.5rem] shrink-0" />
            <Skeleton surface="dark" className="h-3 w-12 shrink-0" />
            <Skeleton surface="dark" className={cn("h-3 shrink-0", LOGGER_WIDTHS[i % LOGGER_WIDTHS.length])} />
            <Skeleton surface="dark" className={cn("h-3", MESSAGE_WIDTHS[i % MESSAGE_WIDTHS.length])} />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}

/** Inline metadata placeholders (PID, log level, buffer capacity) on Live log. */
export function LiveLogMetaSkeleton() {
  return (
    <span aria-hidden="true" className="inline-flex flex-wrap items-center gap-x-4 gap-y-1">
      <Skeleton className="h-3.5 w-24" />
      <Skeleton className="h-3.5 w-32" />
      <Skeleton className="h-3.5 w-44" />
    </span>
  );
}

/** Log files sidebar list while fetching the server's available log files. */
export function LogFileListSkeleton({ count = 6 }: { count?: number }) {
  return (
    <LoadingRegion className="space-y-1">
      <div aria-hidden="true" className="space-y-1">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="rounded-control border border-border/60 bg-surface/60 px-3 py-2">
            <Skeleton className={cn("h-4", FILE_TITLE_WIDTHS[i % FILE_TITLE_WIDTHS.length])} />
            <Skeleton className={cn("mt-1.5 h-3", i % 2 ? "w-32" : "w-36")} />
          </div>
        ))}
        <Skeleton className="mx-3 mt-2 h-2.5 w-32" />
      </div>
    </LoadingRegion>
  );
}

/** Log file console lines on bg-navy-900 while loading a file tail. */
export function LogFileLinesSkeleton({ count = 16 }: { count?: number }) {
  return (
    <LoadingRegion className="space-y-2 py-1">
      <div aria-hidden="true" className="space-y-2">
        {Array.from({ length: count }, (_, i) => (
          <Skeleton key={i} surface="dark" className={cn("h-3", FILE_LINE_WIDTHS[i % FILE_LINE_WIDTHS.length])} />
        ))}
      </div>
    </LoadingRegion>
  );
}

const SERVER_CARDS: { titleWidth: string; rows: { label: string; value: string; meter?: boolean }[] }[] = [
  {
    titleWidth: "w-24",
    rows: [
      { label: "w-14", value: "w-20" },
      { label: "w-16", value: "w-28" },
      { label: "w-14", value: "w-24" },
      { label: "w-16", value: "w-28" },
      { label: "w-20", value: "w-14" },
      { label: "w-14", value: "w-16" },
    ],
  },
  {
    titleWidth: "w-20",
    rows: [
      { label: "w-12", value: "w-24" },
      { label: "w-28", value: "w-24" },
      { label: "w-24", value: "w-28", meter: true },
      { label: "w-20", value: "w-28" },
      { label: "w-20", value: "w-24", meter: true },
    ],
  },
  {
    titleWidth: "w-12",
    rows: [
      { label: "w-12", value: "w-28" },
      { label: "w-24", value: "w-24", meter: true },
      { label: "w-28", value: "w-28" },
      { label: "w-20", value: "w-28" },
      { label: "w-24", value: "w-20" },
    ],
  },
  {
    titleWidth: "w-32",
    rows: [
      { label: "w-24", value: "w-16" },
      { label: "w-24", value: "w-16" },
      { label: "w-32", value: "w-10" },
      { label: "w-28", value: "w-8" },
      { label: "w-24", value: "w-20" },
    ],
  },
];

function JobsTableCardSkeleton({ titleWidth, rows }: { titleWidth: string; rows: number }) {
  return (
    <section className="rounded-card border border-border bg-surface p-4 shadow-card">
      <Skeleton className={cn("h-3.5", titleWidth)} />
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-border">
              {["w-14", "w-12", "w-14", "w-14", "w-14", "w-12"].map((w, i) => (
                <th key={i} className="py-2 pr-3 last:pr-0">
                  <Skeleton className={cn("h-3", w)} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, r) => (
              <tr key={r} className="border-b border-border/60 last:border-0">
                <td className="py-2.5 pr-3">
                  <Skeleton className="h-3.5 w-20" />
                </td>
                <td className="py-2.5 pr-3">
                  <Skeleton className={cn("h-3.5", r % 2 ? "w-32" : "w-40")} />
                  <Skeleton className="mt-1.5 h-3 w-10" />
                </td>
                <td className="py-2.5 pr-3">
                  <Skeleton className="h-5 w-16" rounded="full" />
                </td>
                <td className="py-2.5 pr-3">
                  <Skeleton className={cn("h-3.5", r % 2 ? "w-24" : "w-28")} />
                  <Skeleton className={cn("mt-1.5 h-3", r % 2 ? "w-36" : "w-44")} />
                </td>
                <td className="py-2.5 pr-3">
                  <Skeleton className="h-3.5 w-20" />
                </td>
                <td className="py-2.5">
                  <Skeleton className="h-3.5 w-16" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Server status tab: 4 diagnostic metric cards and 2 job-queue tables. */
export function ServerStatusSkeleton() {
  return (
    <LoadingRegion className="space-y-4">
      <div aria-hidden="true" className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {SERVER_CARDS.map((card, c) => (
            <section key={c} className="rounded-card border border-border bg-surface p-4 shadow-card">
              <Skeleton className={cn("h-3.5", card.titleWidth)} />
              <div className="mt-3 space-y-2">
                {card.rows.map((row, r) => (
                  <div key={r}>
                    <div className="flex items-center justify-between gap-3">
                      <Skeleton className={cn("h-3", row.label)} />
                      <Skeleton className={cn("h-3", row.value)} />
                    </div>
                    {row.meter && <Skeleton className="mt-1.5 h-1.5 w-full" rounded="full" />}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
        <JobsTableCardSkeleton titleWidth="w-36" rows={2} />
        <JobsTableCardSkeleton titleWidth="w-44" rows={3} />
      </div>
    </LoadingRegion>
  );
}

function AdminActionRowSkeleton({ index, last }: { index: number; last: boolean }) {
  return (
    <li className={cn("flex items-start gap-3 border-b border-border/60 px-4 py-3", last && "border-0")}>
      <div className="mt-0.5 w-24 shrink-0">
        <Skeleton className="h-3.5 w-16" />
      </div>
      <Skeleton className="mt-1.5 size-2 shrink-0" rounded="full" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <Skeleton className={cn("h-4", ACTION_TEXT_WIDTHS[index % ACTION_TEXT_WIDTHS.length])} />
        {index % 2 === 0 && <Skeleton className="h-3 w-40" />}
      </div>
      <Skeleton className="mt-1 size-3.5 shrink-0" />
    </li>
  );
}

/** Admin actions timeline card: day headers with grouped audit entries. */
export function AdminActionsSkeleton() {
  const groups = [
    { headerWidth: "w-48", rows: 4 },
    { headerWidth: "w-44", rows: 3 },
  ];

  return (
    <LoadingRegion>
      <ul aria-hidden="true">
        {groups.map((group, g) => (
          <Fragment key={g}>
            <li className="border-b border-border bg-surface/95 px-4 py-2 first:rounded-t-card">
              <Skeleton className={cn("h-3.5", group.headerWidth)} />
            </li>
            {Array.from({ length: group.rows }, (_, i) => (
              <AdminActionRowSkeleton
                key={`${g}-${i}`}
                index={g * 4 + i}
                last={g === groups.length - 1 && i === group.rows - 1}
              />
            ))}
          </Fragment>
        ))}
      </ul>
    </LoadingRegion>
  );
}

/** Appended rows at the bottom of Admin actions while loading older entries. */
export function AdminActionsMoreSkeleton({ count = 3 }: { count?: number }) {
  return (
    <LoadingRegion className="border-t border-border/60">
      <ul aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <AdminActionRowSkeleton key={i} index={i} last={i === count - 1} />
        ))}
      </ul>
    </LoadingRegion>
  );
}
