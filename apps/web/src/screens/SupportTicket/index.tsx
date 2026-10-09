import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, WarningCircle } from "@phosphor-icons/react";
import { SupportThread } from "../../components/support/SupportThread";
import { supportErrorText } from "../../components/support/labels";
import { getMySupportTicket, replyToMySupportTicket, type SupportConversation } from "../../lib/api";
import { t } from "../../lib/i18n";

export default function SupportTicketPage() {
  const number = Number(useParams().number);
  const [conversation, setConversation] = useState<SupportConversation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setConversation(null);
    setError(null);
    getMySupportTicket(number)
      .then((c) => !cancelled && setConversation(c))
      .catch((err: unknown) => !cancelled && setError(supportErrorText(err)));
    return () => {
      cancelled = true;
    };
  }, [number]);

  return (
    <div className="studio-page mx-auto max-w-3xl px-5 py-10 sm:px-8">
      <Link to="/account/support" className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-500 hover:text-navy-900">
        <ArrowLeft size={15} weight="bold" />
        {t("My requests")}
      </Link>
      <div className="mt-5">
        {error && (
          <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-severity-high-line bg-severity-high-bg px-4 py-3.5 text-sm text-severity-high">
            <WarningCircle size={20} weight="fill" className="mt-0.5 shrink-0" />
            <p>{error}</p>
          </div>
        )}
        {!conversation && !error && <p className="mt-10 text-center text-sm text-ink-500">{t("Loading…")}</p>}
        {conversation && (
          <SupportThread
            conversation={conversation}
            onReply={async (body, files) => setConversation(await replyToMySupportTicket(number, body, files))}
          />
        )}
      </div>
    </div>
  );
}
