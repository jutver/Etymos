import type { ReactNode } from "react";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { Skeleton } from "./Skeleton";
import { t, tr } from "../lib/i18n";

/** Placeholder rows while loading; widths vary so it reads as data, not a grid. */
const SKELETON_ROWS = 6;
const SKELETON_WIDTHS = ["w-3/4", "w-1/2", "w-2/3", "w-5/6", "w-2/5"];

export interface Column<T> {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  className?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  emptyMessage?: string;
  onRowClick?: (row: T) => void;
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  emptyMessage = tr("No results."),
  onRowClick,
  page,
  pageCount,
  onPageChange,
}: DataTableProps<T>) {
  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-body" aria-busy={loading || undefined}>
          {loading && <caption className="sr-only">{t("Loading…")}</caption>}
          <thead>
            <tr className="border-b border-border">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    "px-4 py-2.5 text-left text-caption font-medium text-fg-muted",
                    col.className,
                  )}
                >
                  {t(col.label)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: SKELETON_ROWS }, (_, i) => (
                <tr key={i} aria-hidden="true" className="border-b border-border last:border-b-0">
                  {columns.map((col, c) => (
                    <td key={col.key} className={cn("px-4 py-3", col.className)}>
                      <Skeleton className={cn("h-3.5", SKELETON_WIDTHS[(i + c) % SKELETON_WIDTHS.length])} />
                    </td>
                  ))}
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-8 text-center text-fg-subtle">
                  {t(emptyMessage)}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    "border-b border-border last:border-b-0",
                    onRowClick && "cursor-pointer hover:bg-surface-raised",
                  )}
                >
                  {columns.map((col) => (
                    <td key={col.key} className={cn("px-4 py-2.5 text-fg", col.className)}>
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <div className="flex items-center justify-between border-t border-border px-4 py-2.5">
          <span className="text-caption text-fg-subtle">
            {t("Page")}{" "}{page + 1} {" "}{t("of")}{" "}{pageCount}
          </span>
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={page === 0}
              onClick={() => onPageChange(page - 1)}
              className="flex size-7 cursor-pointer items-center justify-center rounded-control border border-border text-fg-muted transition hover:bg-surface-raised active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <CaretLeft size={14} weight="bold" />
            </button>
            <button
              type="button"
              disabled={page >= pageCount - 1}
              onClick={() => onPageChange(page + 1)}
              className="flex size-7 cursor-pointer items-center justify-center rounded-control border border-border text-fg-muted transition hover:bg-surface-raised active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <CaretRight size={14} weight="bold" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
