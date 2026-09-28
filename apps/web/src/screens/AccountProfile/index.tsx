import { useState } from "react";
import { Eye, EyeSlash, LockKey, Trash, User, WarningCircle } from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";
import { useAuth, displayNameFor } from "../../lib/auth";
import { supabase } from "@etymos/shared";
import { useAppStore } from "../../lib/store";
import { t, tr } from "../../lib/i18n";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8000";

export default function AccountProfilePage() {
  const { user } = useAuth();
  const pushToast = useAppStore((s) => s.pushToast);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [name, setName] = useState(displayNameFor(user));
  const [savingName, setSavingName] = useState(false);

  const [recoveryEmail, setRecoveryEmail] = useState((user?.user_metadata?.recovery_email as string) ?? "");
  const [savingRecovery, setSavingRecovery] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [showPasswordFields, setShowPasswordFields] = useState(false);

  const googleIdentity = user?.identities?.find((identity) => identity.provider === "google");

  async function saveName() {
    setSavingName(true);
    const { error } = await supabase.auth.updateUser({ data: { display_name: name } });
    setSavingName(false);
    pushToast(
      error
        ? { kind: "error", title: tr("Couldn't update name"), description: error.message }
        : { kind: "success", title: tr("Name updated") },
    );
  }

  async function saveRecoveryEmail() {
    setSavingRecovery(true);
    const { error } = await supabase.auth.updateUser({ data: { recovery_email: recoveryEmail } });
    setSavingRecovery(false);
    pushToast(
      error
        ? { kind: "error", title: tr("Couldn't update recovery email"), description: error.message }
        : { kind: "success", title: tr("Recovery email updated") },
    );
  }

  async function savePassword() {
    if (!currentPassword) {
      pushToast({ kind: "error", title: tr("Current password required") });
      return;
    }
    if (newPassword.length < 6) {
      pushToast({ kind: "error", title: tr("Password too short"), description: tr("Use at least 6 characters.") });
      return;
    }
    if (newPassword !== confirmPassword) {
      pushToast({ kind: "error", title: tr("Passwords don't match") });
      return;
    }
    if (!user?.email) {
      pushToast({ kind: "error", title: tr("Couldn't update password"), description: tr("No email on this account.") });
      return;
    }

    setSavingPassword(true);

    const { error: reauthError } = await supabase.auth.signInWithPassword({
      email: user.email,
      password: currentPassword,
    });
    if (reauthError) {
      setSavingPassword(false);
      pushToast({ kind: "error", title: tr("Current password is incorrect") });
      return;
    }

    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setSavingPassword(false);
    if (error) {
      pushToast({ kind: "error", title: tr("Couldn't update password"), description: error.message });
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    pushToast({ kind: "success", title: tr("Password updated") });
  }

  async function deleteAccount() {
    setDeletingAccount(true);
    setDeleteError(null);

    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (sessionError || !accessToken) {
        throw new Error(tr("Your session has expired. Please sign in again and retry."));
      }

      const response = await fetch(`${API_BASE_URL}/api/account`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!response.ok) {
        const text = await response.text();
        let detail = text;
        try {
          const parsed = JSON.parse(text) as { detail?: string };
          detail = parsed.detail || text;
        } catch {
          // response wasn't JSON — fall back to raw text
        }
        throw new Error(detail || t("Request failed with {{status}}", { status: response.status }));
      }

      // Only sign out and clear local state after the server confirms deletion.
      await supabase.auth.signOut();
      useAppStore.persist.clearStorage();
      window.location.assign("/");
    } catch (err) {
      setDeletingAccount(false);
      const message = err instanceof Error ? err.message : tr("Something went wrong.");
      setDeleteError(message);
      pushToast({ kind: "error", title: tr("Couldn't delete account"), description: message });
    }
  }

  return (
    <div className="studio-page collection-editorial mx-auto max-w-2xl px-5 py-10 sm:px-8">
      <p aria-hidden="true" className="editorial-kicker mb-3">{t("YOUR PERSONAL SPACE")}</p><h1 className="text-h1 font-bold tracking-tight text-navy-900">{t("My Profile")}</h1>
      <p className="mt-1.5 text-sm text-ink-500">{t("Manage your name, password, and account links.")}</p>

      <section className="studio-card mt-8 rounded-[var(--radius-card-lg)] border border-line bg-white p-6">
        <div className="flex items-center gap-2 text-ink-900">
          <User size={18} weight="bold" />
          <h2 className="text-sm font-bold uppercase tracking-wide">{t("Display name")}</h2>
        </div>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="flex-1 rounded-[var(--radius-control)] border border-line bg-white px-4 py-2.5 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
          />
          <Button loading={savingName} onClick={saveName}>
            {t("Save")}</Button>
        </div>
      </section>

      <section className="studio-card mt-6 rounded-[var(--radius-card-lg)] border border-line bg-white p-6">
        <div className="flex items-center gap-2 text-ink-900">
          <LockKey size={18} weight="bold" />
          <h2 className="text-sm font-bold uppercase tracking-wide">{t("Change password")}</h2>
        </div>
        <div className="mt-4 flex flex-col gap-3">
          <div className="relative">
            <input
              type={showPasswordFields ? "text" : "password"}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder={t("Current password")}
              className="w-full rounded-[var(--radius-control)] border border-line bg-white px-4 py-2.5 pr-10 text-sm placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
            <button
              type="button"
              onClick={() => setShowPasswordFields((v) => !v)}
              aria-label={showPasswordFields ? t("Hide passwords") : t("Show passwords")}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-300 hover:text-ink-500"
            >
              {showPasswordFields ? <EyeSlash size={17} /> : <Eye size={17} />}
            </button>
          </div>
          <input
            type={showPasswordFields ? "text" : "password"}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder={t("New password")}
            className="w-full rounded-[var(--radius-control)] border border-line bg-white px-4 py-2.5 text-sm placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
          />
          <input
            type={showPasswordFields ? "text" : "password"}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder={t("Confirm new password")}
            className="w-full rounded-[var(--radius-control)] border border-line bg-white px-4 py-2.5 text-sm placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
          />
          <Button loading={savingPassword} onClick={savePassword} className="self-start">
            {t("Update password")}</Button>
        </div>
      </section>

      <section className="mt-6 rounded-[var(--radius-card-lg)] border border-line bg-white p-6">
        <h2 className="text-sm font-bold uppercase tracking-wide text-ink-900">{t("Recovery email")}</h2>
        <p className="mt-1 text-xs text-ink-500">
          {t("Used to help you get back into your account if you lose access.")}</p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            type="email"
            value={recoveryEmail}
            onChange={(e) => setRecoveryEmail(e.target.value)}
            placeholder="you@backup-email.com"
            className="flex-1 rounded-[var(--radius-control)] border border-line bg-white px-4 py-2.5 text-sm placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
          />
          <Button loading={savingRecovery} onClick={saveRecoveryEmail}>
            {t("Save")}</Button>
        </div>
      </section>

      <section className="mt-6 rounded-[var(--radius-card-lg)] border border-line bg-white p-6">
        <h2 className="text-sm font-bold uppercase tracking-wide text-ink-900">{t("Connected accounts")}</h2>
        <p className="mt-1 text-xs text-ink-500">
          {t("Sign-in methods linked to your account. To link or unlink Google, sign in with Google using this account's email.")}</p>
        <div className="mt-4 flex items-center justify-between gap-3 rounded-[var(--radius-control)] border border-line bg-white px-4 py-3">
          <div className="flex items-center gap-3">
            <img src="/assets/logo/google.png" alt="" className="size-[18px] object-contain" />
            <p className="text-sm font-semibold text-ink-900">{t("Google")}</p>
          </div>
          <span
            className={
              googleIdentity
                ? "inline-flex items-center rounded-full border border-severity-low-line bg-severity-low-bg px-2.5 py-1 text-xs font-semibold text-severity-low"
                : "inline-flex items-center rounded-full border border-line bg-ink-50 px-2.5 py-1 text-xs font-semibold text-ink-500"
            }
          >
            {googleIdentity ? t("Linked") : t("Not linked")}
          </span>
        </div>
      </section>

      <section className="mt-6 rounded-[var(--radius-card-lg)] border border-severity-high-line bg-white p-6">
        <h2 className="text-sm font-bold uppercase tracking-wide text-severity-high">{t("Danger zone")}</h2>
        <p className="mt-1 text-xs text-ink-500">
          {t("Permanently delete your account and sign out. This can't be undone.")}</p>

        {confirmDelete ? (
          <div className="mt-4 flex items-start gap-3 rounded-[var(--radius-control)] border border-severity-high-line bg-severity-high-bg px-4 py-3 text-sm text-severity-high">
            <WarningCircle size={18} weight="fill" className="mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="font-semibold">{t("Delete your account?")}</p>
              <p className="mt-0.5 text-severity-high/90">
                {t("You'll be signed out immediately and lose access to your documents and history. This can't be undone.")}</p>
              {deleteError && <p className="mt-1.5 font-semibold text-severity-high">{t(deleteError)}</p>}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="danger" loading={deletingAccount} onClick={deleteAccount}>
                {t("Confirm")}</Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setConfirmDelete(false);
                  setDeleteError(null);
                }}
              >
                {t("Cancel")}</Button>
            </div>
          </div>
        ) : (
          <Button
            variant="danger"
            className="mt-4"
            iconLeft={<Trash size={16} />}
            onClick={() => setConfirmDelete(true)}
          >
            {t("Delete account")}</Button>
        )}
      </section>
    </div>
  );
}
