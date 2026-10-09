import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { WarningCircle } from "@phosphor-icons/react";
import { SupportThread } from "../../components/support/SupportThread";
import { supportErrorText } from "../../components/support/labels";
import { getGuestSupportTicket, replyAsGuest, type SupportConversation } from "../../lib/api";
import { t } from "../../lib/i18n";

/** A support request opened from an email link (/support/t/:token), for
 * requests made without an account. The link itself is the key, so it
 * works without signing in. */
export default function GuestSupportTicketPage() {
  const token = useParams().token ?? "";
  const [conversation, setConversation] = useState<SupportConversation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getGuestSupportTicket(token)
      .then((c) => !cancelled && setConversation(c))
      .catch((err: unknown) => !cancelled && setError(supportErrorText(err)));
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="mx-auto max-w-3xl px-5 py-12 sm:px-8 sm:py-16">
      {error && (
        <div className="rounded-[var(--radius-card-lg)] border border-line bg-white p-7 text-center">
          <WarningCircle size={32} weight="fill" className="mx-auto text-severity-high" />
          <p className="mt-3 text-sm text-ink-600">{error}</p>
          <p className="mt-1 text-sm text-ink-500">
            {t("The link may be incomplete. Open it again from our email, or")}{" "}
            <Link to="/contact" className="font-semibold text-brand-600 underline underline-offset-2">
              {t("contact us")}
            </Link>
            .
          </p>
        </div>
      )}
      {!conversation && !error && <p className="mt-10 text-center text-sm text-ink-500">{t("Loading…")}</p>}
      {conversation && (
        <SupportThread
          conversation={conversation}
          onReply={async (body, files) => setConversation(await replyAsGuest(token, body, files))}
        />
      )}
    </div>
  );
}
