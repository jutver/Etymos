import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { CircleNotch } from "@phosphor-icons/react";
import { t } from "../../lib/i18n";

export default function AuthCallbackPage() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && user) {
      navigate("/upload", { replace: true });
    }
  }, [loading, user, navigate]);

  return (
    <div className="studio-card rounded-[var(--radius-card-lg)] border border-line bg-white p-7 shadow-[var(--shadow-card)] sm:p-8">
      <div className="flex flex-col items-center gap-4 py-8">
        <CircleNotch size={32} className="animate-spin motion-reduce:animate-none text-brand-600" />
        <p className="text-sm text-ink-600">{t("Signing you in…")}</p>
      </div>
    </div>
  );
}
