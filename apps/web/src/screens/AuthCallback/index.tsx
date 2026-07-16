import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { CircleNotch } from "@phosphor-icons/react";

export default function AuthCallbackPage() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && user) {
      navigate("/upload", { replace: true });
    }
  }, [loading, user, navigate]);

  return (
    <div className="rounded-[var(--radius-card-lg)] border border-line bg-white p-7 shadow-[var(--shadow-card)] sm:p-8">
      <div className="flex flex-col items-center gap-4 py-8">
        <CircleNotch size={32} className="animate-spin text-brand-600" />
        <p className="text-sm text-ink-600">Signing you in…</p>
      </div>
    </div>
  );
}
