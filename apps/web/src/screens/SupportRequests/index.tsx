import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChatCircleText, Plus, WarningCircle } from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";
import { StatusChip } from "../../components/support/SupportThread";
import { CATEGORY_LABELS, supportErrorText } from "../../components/support/labels";
import { listMySupportTickets, type SupportTicketSummary } from "../../lib/api";
import { currentLocale, t } from "../../lib/i18n";

/** My requests: every support ticket opened from this account, or from its
 * login address before signing in. */
export default function SupportRequestsPage() {
  const [items, setItems] = useState<SupportTicketSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listMySupportTickets()
      .then((r) => !cancelled && setItems(r.items))
      .catch((err: unknown) => !cancelled && setError(supportErrorText(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="studio-page mx-auto max-w-3xl px-5 py-10 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-h1 font-bold tracking-tight text-navy-900">{t("My requests")}</h1>
          <p className="mt-1.5 text-sm text-ink-500">{t("Your conversations with Etymos Support.")}</p>
        </div>
        <Button as="link" to="/contact" size="sm" iconLeft={<Plus size={15} weight="bold" />}>
          {t("New request")}
        </Button>
      </div>

      {error && (
        <div className="mt-6 flex items-start gap-3 rounded-[var(--radius-card)] border border-severity-high-line bg-severity-high-bg px-4 py-3.5 text-sm text-severity-high">
          <WarningCircle size={20} weight="fill" className="mt-0.5 shrink-0" />
          <p>{t("Couldn't load your requests.")} {error}</p>
        </div>
      )}

      {!items && !error && <p className="mt-10 text-center text-sm text-ink-500">{t("Loading…")}</p>}

      {items && items.length === 0 && (
        <div className="mt-7 flex flex-col items-center rounded-[var(--radius-card-lg)] border border-dashed border-line bg-surface-tint px-6 py-12 text-center">
          <ChatCircleText size={28} className="text-ink-300" />
          <p className="mt-3 text-sm font-semibold text-navy-900">{t("No requests yet")}</p>
          <p className="mt-1 text-sm text-ink-500">{t("When you contact support, the conversation shows up here.")}</p>
        </div>
      )}

      {items && items.length > 0 && (
        <ul className="studio-card mt-7 divide-y divide-line overflow-hidden rounded-[var(--radius-card-lg)] border border-line bg-white">
          {items.map((item) => (
            <li key={item.number}>
              <Link to={`/account/support/${item.number}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 hover:bg-surface-tint">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-navy-900">{item.subject}</p>
                  <p className="mt-0.5 text-xs text-ink-500">
                    #{item.number} · {t(CATEGORY_LABELS[item.category])} ·{" "}
                    {t("Updated {{when}}", {
                      when: new Date(item.updated_at).toLocaleString(currentLocale(), { dateStyle: "medium", timeStyle: "short" }),
                    })}
                  </p>
                </div>
                <StatusChip status={item.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
