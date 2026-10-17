import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { Wrench } from "@phosphor-icons/react";
import type { Announcement } from "@etymos/shared";
import { Logo } from "../layout/Logo";
import { LanguageSwitcher } from "../LanguageSwitcher";
import { PageLoader } from "../ui/PageLoader";
import { useAuth } from "../../lib/auth";
import { useAnnouncements } from "../../lib/announcements";
import { fetchMyProfile } from "../../lib/profileQueries";
import { currentLocale, t } from "../../lib/i18n";

/** Still reachable during maintenance, so an admin can sign in. */
const OPEN_PATHS = ["/login", "/auth/callback"];

function MaintenanceScreen({ notice }: { notice: Announcement }) {
  return (
    <div className="flex min-h-dvh flex-col bg-surface-tint">
      <header className="flex items-center justify-between px-5 py-5 sm:px-8">
        <Logo size={36} />
        <LanguageSwitcher />
      </header>
      <main id="main-content" className="flex flex-1 items-center justify-center px-5 pb-20 sm:px-8">
        <div className="studio-card w-full max-w-lg rounded-[var(--radius-card-lg)] border border-line bg-white p-8 text-center shadow-[var(--shadow-card)] sm:p-10">
          <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-severity-moderate-bg text-severity-moderate">
            <Wrench size={26} weight="fill" />
          </div>
          <h1 className="mt-5 text-h2 font-bold tracking-tight text-navy-900">
            {notice.title?.trim() ? t(notice.title) : t("We'll be back soon")}
          </h1>
          <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-ink-600">
            {notice.message.trim()
              ? t(notice.message)
              : t("Etymos is down for maintenance while we make some improvements. Please come back a little later.")}
          </p>
          {notice.starts_at && (
            <p className="mt-5 text-xs text-ink-400">
              {t("Since {{time}}", {
                time: new Date(notice.starts_at).toLocaleString(currentLocale(), { dateStyle: "medium", timeStyle: "short" }),
              })}
            </p>
          )}
        </div>
      </main>
      <footer className="pb-6 text-center text-xs text-ink-400">
        <Link to="/login" className="hover:text-ink-600">
          {t("Admin sign in")}
        </Link>
      </footer>
    </div>
  );
}

/**
 * Locks the whole site while a maintenance announcement is live. Admins get
 * through (with a reminder that visitors are locked out); everyone else sees
 * the maintenance screen until an admin switches it off. Signing in stays
 * possible so an admin can get past it.
 */
export function MaintenanceGate({ children }: { children: ReactNode }) {
  const { maintenance } = useAnnouncements();
  const { user, loading } = useAuth();
  const { pathname } = useLocation();
  const [admin, setAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    if (!maintenance) return;
    if (!user) {
      setAdmin(false);
      return;
    }
    let cancelled = false;
    setAdmin(null);
    fetchMyProfile(user.id)
      .then((p) => !cancelled && setAdmin(p.role === "admin"))
      .catch(() => !cancelled && setAdmin(false));
    return () => {
      cancelled = true;
    };
  }, [maintenance, user?.id]);

  if (!maintenance || OPEN_PATHS.includes(pathname)) return <>{children}</>;
  if (loading || admin === null) return <PageLoader />;
  if (!admin) return <MaintenanceScreen notice={maintenance} />;

  return (
    <>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
        <p className="pointer-events-auto inline-flex items-center gap-2 rounded-full bg-navy-900 px-4 py-2 text-xs font-medium text-white shadow-[var(--shadow-card)]">
          <Wrench size={14} weight="fill" className="text-severity-moderate-line" />
          {t("Maintenance mode is on. Only admins can use the site; everyone else sees the maintenance page.")}
        </p>
      </div>
    </>
  );
}
