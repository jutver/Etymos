import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { CircleNotch } from "@phosphor-icons/react";
import { useAdminAuth } from "../../lib/auth";

export default function AuthCallbackPage() {
  const navigate = useNavigate();
  const { user, loading } = useAdminAuth();

  useEffect(() => {
    if (!loading && user) {
      navigate("/", { replace: true });
    }
  }, [loading, user, navigate]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-6">
      <div className="flex flex-col items-center gap-4 py-8">
        <CircleNotch size={32} className="animate-spin text-accent" />
        <p className="text-body text-fg-muted">Signing you in…</p>
      </div>
    </div>
  );
}
