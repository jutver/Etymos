import { lazy, Suspense, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { POLICY_ROUTES } from "./policies/meta";
import { useAuth } from "../../lib/auth";
import { fetchTermsStatus } from "../../lib/terms";

const TermsGateDialog = lazy(() => import("./TermsGateDialog"));

/** Pages the gate stays out of: the policies themselves (linked from the
 * dialog) and the sign-in flows, which must finish before anything else. */
const EXEMPT_PATHS = [
  ...POLICY_ROUTES.map((p) => p.path),
  "/login",
  "/signup",
  "/verify-email",
  "/auth/callback",
  "/email-verified",
  "/forgot-password",
  "/reset-password",
  "/recover-account",
];

type Status =
  | { kind: "unknown" }
  | { kind: "accepted" }
  | { kind: "required"; updated: boolean };

/**
 * Blocks every page for a signed-in user until they accept the current Terms
 * of Service (lib/terms.ts TERMS_VERSION) — new and existing accounts alike,
 * and again each time the version changes. It can't be dismissed: the only
 * ways out are accepting or signing out.
 *
 * Like the waitlist gate, this is a UI gate; the consent record itself is
 * the terms_acceptances row written by accept_terms().
 */
export function TermsGate() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const [status, setStatus] = useState<Status>({ kind: "unknown" });

  useEffect(() => {
    setStatus({ kind: "unknown" });
    if (!user) return;
    let cancelled = false;
    fetchTermsStatus(user.id)
      .then((s) => !cancelled && setStatus(s.accepted ? { kind: "accepted" } : { kind: "required", updated: s.acceptedBefore }))
      .catch((err: unknown) => {
        console.error("Failed to load terms acceptance", err);
        // Fail closed: required means asking, and accepting again is harmless.
        if (!cancelled) setStatus({ kind: "required", updated: false });
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const open = !!user && status.kind === "required" && !EXEMPT_PATHS.includes(pathname);
  if (!open) return null;

  return (
    <Suspense fallback={null}>
      <TermsGateDialog
        open={open}
        updated={status.kind === "required" && status.updated}
        onAccepted={() => setStatus({ kind: "accepted" })}
      />
    </Suspense>
  );
}
