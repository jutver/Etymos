import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { CircleNotch } from "@phosphor-icons/react";
import { supabase } from "@etymos/shared";
import { useAuth } from "../../lib/auth";
import { useAppStore } from "../../lib/store";
import { fetchMyProfile } from "../../lib/profileQueries";
import { BannedScreen, DeletionConfirmScreen } from "./AccountStatusScreens";
import { t } from "../../lib/i18n";

/** Closed-beta gate state. `unknown` means the profile fetch is still in
 * flight — we must render a loading state rather than guessing, or we'd
 * either flash the app shell at a waitlisted user or bounce an approved one
 * to /waitlist. */
type Access = "unknown" | "allowed" | "blocked";

const WAITLIST_PATH = "/waitlist";

/** Blocks the whole app shell in place of the normal access gate below.
 * `banned` also carries the sign-out we perform for it — once set, it must
 * survive the user going `null` (the ban check signs them out itself), so
 * it's tracked separately from `access` and checked first, before the
 * `!user` redirect-to-login branch would otherwise fire. `deletionRequested`
 * deliberately does NOT sign the user out — they need a live session to
 * confirm deletion with their own JWT. */
type Gate =
  | { kind: "none" }
  | { kind: "banned"; reason: string | null; bannedUntil: string | null }
  | { kind: "deletion-requested" };

function FullPageLoader() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-tint">
      <CircleNotch size={28} weight="bold" className="animate-spin motion-reduce:animate-none text-brand-600" />
      <span className="sr-only">{t("Loading…")}</span>
    </div>
  );
}

export function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();
  const syncFromProfile = useAppStore((s) => s.syncFromProfile);
  const [access, setAccess] = useState<Access>("unknown");
  const [gate, setGate] = useState<Gate>({ kind: "none" });

  useEffect(() => {
    if (!user) {
      setAccess("unknown");
      return;
    }
    let cancelled = false;
    setAccess("unknown");
    fetchMyProfile(user.id)
      .then((profile) => {
        if (cancelled) return;
        syncFromProfile(profile);

        if (profile.isBanned) {
          setGate({ kind: "banned", reason: profile.banReason, bannedUntil: profile.bannedUntil });
          // Fire-and-forget: the banned screen doesn't depend on this
          // resolving, and `gate` staying "banned" is what keeps the screen
          // up even once `user` goes null.
          void supabase.auth.signOut();
          return;
        }
        setGate(profile.deletionRequestedAt ? { kind: "deletion-requested" } : { kind: "none" });

        // Admins bypass the beta gate entirely.
        const allowed = profile.role === "admin" || profile.accessStatus === "approved";
        setAccess(allowed ? "allowed" : "blocked");
      })
      .catch((err: unknown) => {
        console.error("Failed to load profile", err);
        // Fail closed: if we can't confirm approval we send the user to
        // /waitlist rather than into the app. That screen re-fetches, so a
        // transient error resolves on its own once the request succeeds.
        if (!cancelled) setAccess("blocked");
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id, syncFromProfile]);

  if (gate.kind === "banned") {
    return <BannedScreen reason={gate.reason} bannedUntil={gate.bannedUntil} />;
  }

  if (gate.kind === "deletion-requested") {
    return <DeletionConfirmScreen />;
  }

  if (loading) {
    return <FullPageLoader />;
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  // Session exists but access_status isn't known yet — hold here so we never
  // render the app shell (or /waitlist) on a guess.
  if (access === "unknown") {
    return <FullPageLoader />;
  }

  const onWaitlist = location.pathname === WAITLIST_PATH;

  if (access === "blocked" && !onWaitlist) {
    return <Navigate to={WAITLIST_PATH} replace />;
  }

  if (access === "allowed" && onWaitlist) {
    return <Navigate to="/upload" replace />;
  }

  return <Outlet />;
}
