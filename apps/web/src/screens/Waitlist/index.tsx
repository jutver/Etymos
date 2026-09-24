import { useEffect, useState } from "react";
import { Hourglass, SignOut, XCircle } from "@phosphor-icons/react";
import { supabase } from "@etymos/shared";
import { Button } from "../../components/ui/Button";
import { Logo } from "../../components/layout/Logo";
import { useAuth } from "../../lib/auth";
import { fetchMyProfile, type MyProfile } from "../../lib/profileQueries";
import { t, currentLocale } from "../../lib/i18n";

function formatRequestedAt(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(currentLocale(), {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Landing spot for a signed-in user who has not been approved for the closed
 * beta. RequireAuth routes them here; this screen is deliberately a dead end
 * apart from logging out.
 */
export default function WaitlistPage() {
  const { user } = useAuth();
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    fetchMyProfile(user.id)
      .then((p) => {
        if (!cancelled) setProfile(p);
      })
      .catch((err: unknown) => console.error("Failed to load profile", err));
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  async function handleSignOut() {
    setSigningOut(true);
    await supabase.auth.signOut();
    // Auth state change tears down the session; RequireAuth sends us to /login.
  }

  const rejected = profile?.accessStatus === "rejected";
  const requestedAt = formatRequestedAt(profile?.accessRequestedAt ?? null);
  const reviewedAt = formatRequestedAt(profile?.accessReviewedAt ?? null);

  return (
    <div className="flex min-h-dvh flex-col bg-surface-tint">
      <header className="px-5 py-6 sm:px-8">
        <Logo />
      </header>

      <div className="flex flex-1 items-start justify-center px-5 pb-16 sm:px-8">
        <div className="w-full max-w-md rounded-[var(--radius-card-lg)] border border-line bg-white p-7 shadow-[var(--shadow-card)] sm:p-8">
          <div
            className={
              rejected
                ? "flex size-12 items-center justify-center rounded-full bg-severity-high-bg text-severity-high"
                : "flex size-12 items-center justify-center rounded-full bg-brand-100 text-brand-600"
            }
          >
            {rejected ? <XCircle size={22} weight="fill" /> : <Hourglass size={22} weight="fill" />}
          </div>

          <h1 className="mt-4 text-h3 font-bold tracking-tight text-navy-900">
            {rejected ? t("Access not granted") : t("You're on the waitlist")}
          </h1>

          <p className="mt-2.5 text-sm leading-relaxed text-ink-600">
            {rejected
              ? t("We weren't able to approve your request for the closed beta at this time. If you think this was a mistake, reply to your signup email and we'll take another look.")
              : t("Etymos is in closed beta and every account is reviewed by an admin before it's activated. Your request is in the queue — we'll email you the moment you're approved.")}
          </p>

          <dl className="mt-6 flex flex-col gap-3 border-t border-line pt-5 text-sm">
            {user?.email && (
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-ink-500">{t("Account")}</dt>
                <dd className="truncate font-medium text-ink-900">{user.email}</dd>
              </div>
            )}
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-ink-500">{t("Status")}</dt>
              <dd className="font-medium text-ink-900">
                {rejected ? t("Rejected") : t("Awaiting approval")}
              </dd>
            </div>
            {requestedAt && (
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-ink-500">{t("Requested")}</dt>
                <dd className="font-medium text-ink-900">{requestedAt}</dd>
              </div>
            )}
            {rejected && reviewedAt && (
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-ink-500">{t("Reviewed")}</dt>
                <dd className="font-medium text-ink-900">{reviewedAt}</dd>
              </div>
            )}
          </dl>

          {profile?.accessNote && (
            <p className="mt-5 rounded-[var(--radius-control)] border border-line bg-surface-muted px-4 py-3 text-sm leading-relaxed text-ink-600">
              {profile.accessNote}
            </p>
          )}

          <Button
            variant="outline"
            size="lg"
            fullWidth
            className="mt-6"
            loading={signingOut}
            onClick={handleSignOut}
            iconLeft={<SignOut size={18} />}
          >
            {t("Log out")}</Button>
        </div>
      </div>
    </div>
  );
}
