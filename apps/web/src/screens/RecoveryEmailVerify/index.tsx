import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/ui/Button";
import { PageLoader } from "../../components/ui/PageLoader";
import { AuthResultCard } from "../../components/auth/AuthResultCard";
import { ApiError, verifyRecoveryEmail } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { t } from "../../lib/i18n";

type Outcome = { kind: "verified"; email: string } | { kind: "expired" | "in_use" | "invalid" | "network" };

/** Landing page for the link in the "confirm your recovery email" email.
 * The token is in the URL fragment (never sent to servers in logs or
 * Referer); it's single-use, so it's redeemed exactly once. */
export default function RecoveryEmailVerifyPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("token"));
  const [outcome, setOutcome] = useState<Outcome | null>(token ? null : { kind: "invalid" });
  // StrictMode runs effects twice in development; a second redemption of a
  // single-use token would report "invalid" over the real result.
  const redeemed = useRef(false);

  useEffect(() => {
    if (!token || redeemed.current) return;
    redeemed.current = true;
    window.history.replaceState(window.history.state, "", window.location.pathname);
    verifyRecoveryEmail(token)
      .then((status) => setOutcome({ kind: "verified", email: status.email ?? "" }))
      .catch((err: unknown) => {
        if (!(err instanceof ApiError)) return setOutcome({ kind: "network" });
        setOutcome({ kind: err.status === 410 ? "expired" : err.status === 409 ? "in_use" : "invalid" });
      });
  }, [token]);

  if (!outcome) return <PageLoader />;

  const next = user
    ? { label: t("Back to your profile"), to: "/account/profile" }
    : { label: t("Back to Login"), to: "/login" };
  const action = (
    <Button size="lg" fullWidth onClick={() => navigate(next.to, { replace: true })}>
      {next.label}
    </Button>
  );

  switch (outcome.kind) {
    case "verified":
      return (
        <AuthResultCard tone="success" title={t("Recovery email confirmed")} actions={action}>
          {t("You can now use {{email}} to reset your password if you lose access to your login email.", {
            email: outcome.email,
          })}
        </AuthResultCard>
      );
    case "expired":
      return (
        <AuthResultCard tone="error" title={t("This link has expired")} actions={action}>
          {t("Confirmation links work for 30 minutes. Open your profile and send a new one.")}
        </AuthResultCard>
      );
    case "in_use":
      return (
        <AuthResultCard tone="error" title={t("This address is already in use")} actions={action}>
          {t("It's the confirmed recovery email of another Etymos account. Choose a different address in your profile.")}
        </AuthResultCard>
      );
    case "network":
      return (
        <AuthResultCard tone="error" title={t("Something went wrong")} actions={action}>
          {t("We couldn't reach Etymos. Check your connection and open the link again.")}
        </AuthResultCard>
      );
    default:
      return (
        <AuthResultCard tone="error" title={t("This link can't be used")} actions={action}>
          {t("It may have been used already or replaced by a newer one. Check your recovery email in your profile.")}
        </AuthResultCard>
      );
  }
}
