// Blocking, dedicated screens shown by RequireAuth in place of the app shell
// when the signed-in user's own profile says their account is banned or has
// a pending admin-requested deletion (CHANGES_I_WANT.md Admin Portal #3).
// Visual style mirrors VerifyStudent's pending/rejected states for
// consistency with the rest of the account-status UI.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Prohibit, Warning } from "@phosphor-icons/react";
import { supabase } from "@etymos/shared";
import { Button } from "../ui/Button";
import { useAppStore } from "../../lib/store";
import { deleteOwnAccount } from "../../lib/api";
import { t, tr, currentLocale } from "../../lib/i18n";

import { SUPPORT_EMAIL } from "../support/labels";

export function BannedScreen({ reason, bannedUntil }: { reason: string | null; bannedUntil: string | null }) {
  const navigate = useNavigate();

  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-tint px-5 py-14 sm:px-8">
      <div className="mx-auto w-full max-w-xl">
        <div className="flex size-12 items-center justify-center rounded-full bg-severity-high-bg text-severity-high">
          <Prohibit size={24} weight="fill" />
        </div>
        <h1 className="mt-4 text-h2 font-bold tracking-tight text-navy-900">
          {t("Your account has been suspended")}</h1>
        <p className="mt-1.5 text-sm text-ink-500">
          {bannedUntil
            ? t("Sign-in is disabled until {{n}}.", { n: new Date(bannedUntil).toLocaleString(currentLocale()) })
            : t("Sign-in is disabled until an administrator lifts this suspension.")}
        </p>

        <div className="studio-card mt-8 rounded-[var(--radius-card-lg)] border border-line bg-white p-6 shadow-[var(--shadow-card)]">
          <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-severity-high-line bg-severity-high-bg px-5 py-3.5 text-sm text-severity-high">
            <Warning size={20} weight="fill" className="mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold">{t("Message from the admin team")}</p>
              <p className="mt-0.5 text-severity-high/90">{t(reason) || t("No reason was provided.")}</p>
            </div>
          </div>

          <p className="mt-4 text-xs text-ink-400">
            {t("If you believe this is a mistake, contact support.")}{" "}
            <Link to="/contact" className="font-semibold text-brand-600 underline underline-offset-2">
              {t("Contact support")}
            </Link>{" "}
            {t("or email")}{" "}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="font-semibold text-brand-600 underline underline-offset-2">
              {SUPPORT_EMAIL}
            </a>
          </p>

          <Button size="lg" variant="outline" fullWidth className="mt-6" onClick={() => navigate("/login")}>
            {t("Back to sign in")}</Button>
        </div>
      </div>
    </div>
  );
}

export function DeletionConfirmScreen() {
  const navigate = useNavigate();
  const pushToast = useAppStore((s) => s.pushToast);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setConfirming(true);
    setError(null);
    try {
      await deleteOwnAccount();
      // Mirrors AccountProfile's self-delete flow: only sign out and clear
      // local state after the server confirms deletion.
      await supabase.auth.signOut();
      useAppStore.persist.clearStorage();
      window.location.assign("/");
    } catch (err) {
      setConfirming(false);
      const message = err instanceof Error ? err.message : tr("Something went wrong.");
      setError(message);
      pushToast({ kind: "error", title: tr("Couldn't delete account"), description: message });
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-tint px-5 py-14 sm:px-8">
      <div className="mx-auto w-full max-w-xl">
        <div className="flex size-12 items-center justify-center rounded-full bg-severity-high-bg text-severity-high">
          <Warning size={24} weight="fill" />
        </div>
        <h1 className="mt-4 text-h2 font-bold tracking-tight text-navy-900">{t("Account deletion requested")}</h1>
        <p className="mt-1.5 text-sm text-ink-500">
          {t("An administrator has requested deletion of your account. Click confirm to proceed, or contact support if this is a mistake.")}</p>

        <div className="studio-card mt-8 rounded-[var(--radius-card-lg)] border border-line bg-white p-6 shadow-[var(--shadow-card)]">
          <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-severity-high-line bg-severity-high-bg px-5 py-3.5 text-sm text-severity-high">
            <Warning size={20} weight="fill" className="mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold">{t("This can't be undone")}</p>
              <p className="mt-0.5 text-severity-high/90">
                {t("Confirming permanently deletes your account, documents, and history, and signs you out.")}</p>
              {error && <p className="mt-1.5 font-semibold text-severity-high">{error}</p>}
            </div>
          </div>

          <Button size="lg" variant="danger" fullWidth loading={confirming} className="mt-6" onClick={handleConfirm}>
            {t("Confirm deletion")}</Button>

          <p className="mt-3 text-center text-[0.6875rem] text-ink-400">
            {t("Think this is a mistake?")}{" "}
            <Link to="/contact" className="font-semibold text-brand-600 underline underline-offset-2">
              {t("Contact support")}</Link>{" "}
            {t("instead of confirming.")}</p>
        </div>

        <button
          type="button"
          onClick={() => {
            supabase.auth.signOut().finally(() => navigate("/login"));
          }}
          className="mt-4 w-full text-center text-xs text-ink-400 underline underline-offset-2 hover:text-ink-500"
        >
          {t("Sign out without confirming")}</button>
      </div>
    </div>
  );
}
