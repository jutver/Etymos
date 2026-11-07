// The Transactions/Orders date filter's value, read from and written to the
// URL: ?day=yyyy-mm-dd for one day, ?from=&to= for a range, neither for all time.
import type { DaySpan } from "../../lib/revenueQueries";

export type DateMode = "all" | "day" | "range";

export interface DateSelection {
  mode: DateMode;
  /** null for all time. */
  span: DaySpan | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function readDateSelection(params: URLSearchParams): DateSelection {
  const day = params.get("day");
  if (day && DAY.test(day)) return { mode: "day", span: { start: day, end: day } };
  const from = params.get("from");
  const to = params.get("to");
  if (from && to && DAY.test(from) && DAY.test(to)) {
    return { mode: "range", span: from <= to ? { start: from, end: to } : { start: to, end: from } };
  }
  return { mode: "all", span: null };
}

/** `params` with the date selection replaced and everything else kept. */
export function withDateSelection(params: URLSearchParams, selection: DateSelection): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete("day");
  next.delete("from");
  next.delete("to");
  if (selection.span && selection.mode === "day") next.set("day", selection.span.start);
  if (selection.span && selection.mode === "range") {
    next.set("from", selection.span.start);
    next.set("to", selection.span.end);
  }
  return next;
}
