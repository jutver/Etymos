import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAdminAuth } from "../../lib/auth";

export function RequireAdmin() {
  const { user, loading, isAdmin, roleStatus } = useAdminAuth();
  const location = useLocation();

  if (loading) {
    return <div className="min-h-dvh bg-bg" />;
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (roleStatus === "not-admin" || !isAdmin) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg px-6">
        <div className="max-w-sm rounded-card border border-border bg-surface p-8 text-center">
          <h1 className="text-h2 font-semibold text-fg">Not authorized</h1>
          <p className="mt-2 text-body text-fg-muted">
            This account doesn't have admin access. Contact a maintainer if you believe this is a mistake.
          </p>
        </div>
      </div>
    );
  }

  return <Outlet />;
}
