import { useEffect, useId, useState, type UIEvent } from "react";
import { useLocation } from "react-router-dom";
import { ArrowSquareOut, Scroll, WarningCircle } from "@phosphor-icons/react";
import { supabase } from "@etymos/shared";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { PolicyBody } from "./PolicyBody";
import { POLICIES, TERMS } from "./policies";
import { useAuth } from "../../lib/auth";
import { t } from "../../lib/i18n";
import { acceptTerms, fetchTermsStatus, termsDate, TERMS_VERSION } from "../../lib/terms";

/** Pages the gate stays out of: the policies themselves (linked from the
 * dialog) and the sign-in flows, which must finish before anything else. */
const EXEMPT_PATHS = [
  ...POLICIES.map((p) => p.path),
  "/login",
  "/signup",
  "/verify-email",
  "/auth/callback",
  "/email-verified",
  "/forgot-password",
  "/reset-password",
  "/recover-account",
];

/** Modal re-runs its focus effect when onClose changes, so keep it stable. */
const ignoreClose = () => {};

type Status =
  | { kind: "unknown" }
  | { kind: "accepted" }
  | { kind: "required"; updated: boolean };

/**
 * Blocks every page for a signed-in user until they accept the current Terms
 * of Service (lib/terms.ts TERMS_VERSION) — new and existing accounts alike,
 * and again each time the version changes. It can't be dismissed: the only
 * ways out are accepting or signing out.
 *
 * Like the closed-beta gate, this is a UI gate; the consent record itself is
 * the terms_acceptances row written by accept_terms().
 */
export function TermsGate() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const [status, setStatus] = useState<Status>({ kind: "unknown" });
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [atEnd, setAtEnd] = useState(false);
  const titleId = useId();

  useEffect(() => {
    setStatus({ kind: "unknown" });
    setAgreed(false);
    setError(null);
    if (!user) return;
    let cancelled = false;
    fetchTermsStatus(user.id)
      .then((s) => !cancelled && setStatus(s.accepted ? { kind: "accepted" } : { kind: "required", updated: s.acceptedBefore }))
      .catch((err: unknown) => {
        console.error("Failed to load terms acceptance", err);
        // Fail closed: required means asking, and accepting again is harmless.
        if (!cancelled) setStatus({ kind: "required", updated: false });
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  /** Hides the bottom fade once the reader reaches the end of the Terms. */
  function handleScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    setAtEnd(el.scrollTop + el.clientHeight >= el.scrollHeight - 8);
  }

  async function handleAccept() {
    setSaving(true);
    setError(null);
    try {
      await acceptTerms();
      setStatus({ kind: "accepted" });
    } catch (err) {
      console.error("Failed to accept terms", err);
      setError(t("We couldn't save your acceptance. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  const open = !!user && status.kind === "required" && !EXEMPT_PATHS.includes(pathname);
  const updated = status.kind === "required" && status.updated;

  return (
    // No way to close it: Escape and the backdrop do nothing.
    <Modal open={open} onClose={ignoreClose} maxWidth="max-w-2xl" labelledBy={titleId}>
      <div className="p-6 sm:p-8" data-terms-version={TERMS_VERSION}>
        <div className="flex size-11 items-center justify-center rounded-full bg-brand-100 text-brand-600">
          <Scroll size={22} weight="fill" />
        </div>
        <h2 id={titleId} className="mt-4 text-h3 font-bold tracking-tight text-navy-900">
          {updated ? t("We've updated our Terms of Service") : t("Accept our Terms of Service")}</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-600">
          {updated
            ? t("Our Terms changed on {{date}}. Please read and accept them to keep using Etymos.", { date: termsDate() })
            : t("Please read and accept the Terms before using Etymos.")}</p>

        {/* The frame owns the border and rounded corners; the scroller sits
            inset inside it, so the scrollbar never runs into the corners. */}
        <div className="relative mt-5 overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface-tint">
          <div
            onScroll={handleScroll}
            className="my-1.5 mr-1.5 max-h-[40dvh] overflow-y-auto overscroll-contain scrollbar-thin py-2.5 pl-4 pr-3 sm:pl-5"
          >
            <PolicyBody policy={TERMS} className="space-y-6" />
          </div>
          <div
            aria-hidden
            className={`pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-surface-tint to-transparent transition-opacity duration-200 ${
              atEnd ? "opacity-0" : "opacity-100"
            }`}
          />
        </div>
        <p className="mt-4 text-xs font-semibold text-ink-500">{t("These policies are part of the Terms:")}</p>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
          {POLICIES.filter((p) => p !== TERMS).map((p) => (
            <li key={p.slug}>
              <a
                href={p.path}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:underline"
              >
                {t(p.title)}
                <ArrowSquareOut size={12} />
              </a>
            </li>
          ))}
        </ul>

        <label className="mt-5 flex cursor-pointer items-start gap-3 text-sm text-ink-700">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-brand-600"
          />
          <span>{t("I have read and agree to the Terms of Service and the policies that are part of them.")}</span>
        </label>

        {error && (
          <div className="mt-4 flex items-start gap-2.5 rounded-[var(--radius-control)] border border-severity-high-line bg-severity-high-bg px-4 py-3 text-sm text-severity-high">
            <WarningCircle size={18} weight="fill" className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={() => void supabase.auth.signOut()} disabled={saving}>
            {t("Log out")}</Button>
          <Button onClick={handleAccept} disabled={!agreed} loading={saving}>
            {t("Accept and continue")}</Button>
        </div>
      </div>
    </Modal>
  );
}
