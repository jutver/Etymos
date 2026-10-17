import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft } from "@phosphor-icons/react";
import { SupportRequestForm } from "../../components/support/SupportRequestForm";
import { useAppStore } from "../../lib/store";
import { t } from "../../lib/i18n";

/** New support request from inside the account. Signed-out visitors use
 * /contact, which sends signed-in users here. */
export default function NewSupportRequestPage() {
  const navigate = useNavigate();
  const pushToast = useAppStore((s) => s.pushToast);

  return (
    <div className="studio-page mx-auto max-w-3xl px-5 py-10 sm:px-8">
      <Link to="/account/support" className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-500 hover:text-navy-900">
        <ArrowLeft size={15} weight="bold" />
        {t("My requests")}
      </Link>
      <h1 className="mt-5 text-h1 font-bold tracking-tight text-navy-900">{t("New request")}</h1>
      <p className="mt-1.5 text-sm text-ink-500">
        {t("Tell us what's going on and we'll get back to you by email, usually within one business day.")}
      </p>

      <SupportRequestForm
        className="mt-7"
        onSent={(sent) => {
          pushToast({
            kind: "success",
            title: t("Request #{{number}} received", { number: sent.number }),
            description: t("We've emailed a confirmation to {{email}}.", { email: sent.email }),
          });
          navigate(`/account/support/${sent.number}`, { replace: true });
        }}
      />
    </div>
  );
}
