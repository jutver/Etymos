// Overview card: everything that came in by bank transfer in one calendar
// month (Vietnam time), with arrows to step through months and a link to
// that month's transfers.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUp, CaretLeft, CaretRight } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import {
  fetchMonthlyTransfers,
  monthSpan,
  shiftMonth,
  todayVN,
  type MonthlyTransfers as MonthlyTotals,
} from "../../lib/revenueQueries";
import { friendlyError } from "../../lib/errors";
import { currentLocale, t, tn } from "../../lib/i18n";
import { formatVND } from "./format";

function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(currentLocale(), {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

const arrowButton =
  "flex size-7 items-center justify-center rounded-md text-fg-muted transition hover:bg-surface-raised hover:text-fg disabled:pointer-events-none disabled:opacity-40";

export function MonthlyTransfers() {
  const thisMonth = todayVN().slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [data, setData] = useState<MonthlyTotals | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetchMonthlyTransfers(month)
      .then((d) => !cancelled && setData(d))
      .catch((err: unknown) => !cancelled && setError(friendlyError(err)));
    return () => {
      cancelled = true;
    };
  }, [month]);

  const span = monthSpan(month);
  const change =
    data && data.previousIncoming > 0 ? ((data.incoming - data.previousIncoming) / data.previousIncoming) * 100 : null;

  return (
    <section className="rounded-card border border-border bg-surface p-5 shadow-card" aria-labelledby="monthly-transfers">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="monthly-transfers" className="text-caption font-medium text-fg-muted">
          {t("Transfers received in {{month}}", { month: monthName(month) })}
        </h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={arrowButton}
            title={t("Previous month")}
            aria-label={t("Previous month")}
            onClick={() => setMonth((m) => shiftMonth(m, -1))}
          >
            <CaretLeft size={14} weight="bold" />
          </button>
          <span className="min-w-[8.5rem] text-center text-caption font-medium text-fg">{monthName(month)}</span>
          <button
            type="button"
            className={arrowButton}
            title={t("Next month")}
            aria-label={t("Next month")}
            disabled={month >= thisMonth}
            onClick={() => setMonth((m) => shiftMonth(m, 1))}
          >
            <CaretRight size={14} weight="bold" />
          </button>
        </div>
      </div>

      {error ? (
        <p className="mt-3 text-caption text-destructive">{error}</p>
      ) : (
        <div className="mt-2 flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
          <div className="min-w-0">
            <p className="font-mono text-h1 font-semibold tabular-nums text-fg">
              {data ? formatVND(data.incoming) : "…"}
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 text-caption text-fg-muted">
              <span>{data ? tn(data.incomingCount, "{{count}} transfer", "{{count}} transfers") : "…"}</span>
              {data && change !== null && (
                <span
                  className={cn(
                    "inline-flex items-center gap-0.5 font-medium",
                    change >= 0 ? "text-success" : "text-destructive",
                  )}
                >
                  {change >= 0 ? <ArrowUp size={12} weight="bold" /> : <ArrowDown size={12} weight="bold" />}
                  {t("{{percent}}% vs {{month}}", {
                    percent: Math.abs(Math.round(change)),
                    month: monthName(shiftMonth(month, -1)),
                  })}
                </span>
              )}
              {data && change === null && data.incoming > 0 && (
                <span className="text-fg-subtle">{t("Nothing came in the month before")}</span>
              )}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            {data && data.outgoingCount > 0 && (
              <div>
                <p className="text-caption text-fg-muted">{t("Sent out")}</p>
                <p className="font-mono text-body text-fg">
                  −{formatVND(data.outgoing)}{" "}
                  <span className="text-caption text-fg-subtle">
                    ({tn(data.outgoingCount, "{{count}} transfer", "{{count}} transfers")})
                  </span>
                </p>
              </div>
            )}
            <Link
              to={`/revenue/transactions?filter=all&from=${span.start}&to=${span.end}`}
              className="text-caption font-medium text-accent hover:underline"
            >
              {t("See this month's transfers")}
            </Link>
          </div>
        </div>
      )}
    </section>
  );
}
