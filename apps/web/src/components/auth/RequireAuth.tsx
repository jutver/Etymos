import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../../lib/auth";

export function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="min-h-dvh bg-surface-tint" />;
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <Outlet />;
}
