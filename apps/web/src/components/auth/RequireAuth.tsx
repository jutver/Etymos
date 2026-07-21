import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { CircleNotch } from "@phosphor-icons/react";
import { useAuth } from "../../lib/auth";
import { useAppStore } from "../../lib/store";
import { fetchMyProfile } from "../../lib/profileQueries";

/** Closed-beta gate state. `unknown` means the profile fetch is still in
 * flight — we must render a loading state rather than guessing, or we'd
 * either flash the app shell at a waitlisted user or bounce an approved one
 * to /waitlist. */
type Access = "unknown" | "allowed" | "blocked";

const WAITLIST_PATH = "/waitlist";

function FullPageLoader() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-tint">
      <CircleNotch size={28} weight="bold" className="animate-spin motion-reduce:animate-none text-brand-600" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();
  const syncFromProfile = useAppStore((s) => s.syncFromProfile);
  const [access, setAccess] = useState<Access>("unknown");

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
