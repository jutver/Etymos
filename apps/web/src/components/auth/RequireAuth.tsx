import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { useAppStore } from "../../lib/store";
import { fetchMyProfile } from "../../lib/profileQueries";

export function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();
  const syncFromProfile = useAppStore((s) => s.syncFromProfile);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    fetchMyProfile(user.id)
      .then((profile) => {
        if (!cancelled) syncFromProfile(profile);
      })
      .catch((err: unknown) => console.error("Failed to load profile", err));
    return () => {
      cancelled = true;
    };
  }, [user?.id, syncFromProfile]);

  if (loading) {
    return <div className="min-h-dvh bg-surface-tint" />;
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <Outlet />;
}
