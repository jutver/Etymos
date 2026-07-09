import { useState } from "react";
import { LockKey, Trash, User, WarningCircle } from "@phosphor-icons/react";
import { Button } from "../../components/ui/Button";
import { Toggle } from "../../components/ui/Toggle";
import { useAuth, displayNameFor } from "../../lib/auth";
import { supabase } from "../../lib/supabase";
import { useAppStore } from "../../lib/store";

export default function AccountProfilePage() {
  const { user } = useAuth();
  const pushToast = useAppStore((s) => s.pushToast);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);

  const [name, setName] = useState(displayNameFor(user));
  const [savingName, setSavingName] = useState(false);

  const [recoveryEmail, setRecoveryEmail] = useState((user?.user_metadata?.recovery_email as string) ?? "");
  const [savingRecovery, setSavingRecovery] = useState(false);

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  const [googleLinked, setGoogleLinked] = useState(Boolean(user?.user_metadata?.google_linked));
  const [linkingGoogle, setLinkingGoogle] = useState(false);

  async function saveName() {
    setSavingName(true);
    const { error } = await supabase.auth.updateUser({ data: { display_name: name } });
    setSavingName(false);
    pushToast(
      error
        ? { kind: "error", title: "Couldn't update name", description: error.message }
        : { kind: "success", title: "Name updated" },
    );
  }

  async function saveRecoveryEmail() {
    setSavingRecovery(true);
    const { error } = await supabase.auth.updateUser({ data: { recovery_email: recoveryEmail } });
    setSavingRecovery(false);
    pushToast(
      error
        ? { kind: "error", title: "Couldn't update recovery email", description: error.message }
        : { kind: "success", title: "Recovery email updated" },
    );
  }

  async function savePassword() {
    if (newPassword.length < 6) {
      pushToast({ kind: "error", title: "Password too short", description: "Use at least 6 characters." });
      return;
    }
    if (newPassword !== confirmPassword) {
      pushToast({ kind: "error", title: "Passwords don't match" });
      return;
    }
    setSavingPassword(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setSavingPassword(false);
    if (error) {
      pushToast({ kind: "error", title: "Couldn't update password", description: error.message });
      return;
    }
    setNewPassword("");
    setConfirmPassword("");
    pushToast({ kind: "success", title: "Password updated" });
  }

  async function toggleGoogleLink(next: boolean) {
    setLinkingGoogle(true);
    const { error } = await supabase.auth.updateUser({ data: { google_linked: next } });
    setLinkingGoogle(false);
    if (error) {
      pushToast({ kind: "error", title: "Couldn't update Google link", description: error.message });
      return;
    }
    setGoogleLinked(next);
    pushToast({
      kind: "success",
      title: next ? "Google account linked" : "Google account unlinked",
      description: "Demo mockup — no real Google account is contacted.",
    });
  }

  async function deleteAccount() {
    setDeletingAccount(true);
    await supabase.auth.signOut();
    useAppStore.persist.clearStorage();
    window.location.assign("/");
  }

  return (
    <div className="mx-auto max-w-2xl px-5 py-10 sm:px-8">
      <h1 className="text-h1 font-bold tracking-tight text-navy-900">My Profile</h1>
      <p className="mt-1.5 text-sm text-ink-500">Manage your name, password, and account links.</p>

      <section className="mt-8 rounded-[var(--radius-card-lg)] border border-line bg-white p-6">
        <div className="flex items-center gap-2 text-ink-900">
          <User size={18} weight="bold" />
          <h2 className="text-sm font-bold uppercase tracking-wide">Display name</h2>
        </div>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="flex-1 rounded-[var(--radius-control)] border border-line bg-white px-4 py-2.5 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
          />
          <Button loading={savingName} onClick={saveName}>
            Save
          </Button>
        </div>
      </section>

      <section className="mt-6 rounded-[var(--radius-card-lg)] border border-line bg-white p-6">
        <div className="flex items-center gap-2 text-ink-900">
          <LockKey size={18} weight="bold" />
          <h2 className="text-sm font-bold uppercase tracking-wide">Change password</h2>
        </div>
        <div className="mt-4 flex flex-col gap-3">
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="New password"
            className="w-full rounded-[var(--radius-control)] border border-line bg-white px-4 py-2.5 text-sm placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
          />
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Confirm new password"
            className="w-full rounded-[var(--radius-control)] border border-line bg-white px-4 py-2.5 text-sm placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
          />
          <Button loading={savingPassword} onClick={savePassword} className="self-start">
            Update password
          </Button>
        </div>
      </section>

      <section className="mt-6 rounded-[var(--radius-card-lg)] border border-line bg-white p-6">
        <h2 className="text-sm font-bold uppercase tracking-wide text-ink-900">Recovery email</h2>
        <p className="mt-1 text-xs text-ink-500">
          Used to help you get back into your account if you lose access.
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            type="email"
            value={recoveryEmail}
            onChange={(e) => setRecoveryEmail(e.target.value)}
            placeholder="you@backup-email.com"
            className="flex-1 rounded-[var(--radius-control)] border border-line bg-white px-4 py-2.5 text-sm placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
          />
          <Button loading={savingRecovery} onClick={saveRecoveryEmail}>
            Save
          </Button>
        </div>
      </section>

      <section className="mt-6 rounded-[var(--radius-card-lg)] border border-line bg-white p-6">
        <h2 className="text-sm font-bold uppercase tracking-wide text-ink-900">Connected accounts</h2>
        <div className="mt-4">
          <Toggle
            checked={googleLinked}
            onChange={toggleGoogleLink}
            label="Google"
            description={linkingGoogle ? "Updating..." : googleLinked ? "Linked (demo mockup)" : "Not linked"}
            icon={<img src="/assets/logo/google.png" alt="" className="size-[18px] object-contain" />}
          />
        </div>
      </section>

      <section className="mt-6 rounded-[var(--radius-card-lg)] border border-severity-high-line bg-white p-6">
        <h2 className="text-sm font-bold uppercase tracking-wide text-severity-high">Danger zone</h2>
        <p className="mt-1 text-xs text-ink-500">
          Permanently delete your account and sign out. This can't be undone.
        </p>

        {confirmDelete ? (
          <div className="mt-4 flex items-start gap-3 rounded-[var(--radius-control)] border border-severity-high-line bg-severity-high-bg px-4 py-3 text-sm text-severity-high">
            <WarningCircle size={18} weight="fill" className="mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="font-semibold">Delete your account?</p>
              <p className="mt-0.5 text-severity-high/90">
                You'll be signed out immediately and lose access to your documents and history.
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="danger" loading={deletingAccount} onClick={deleteAccount}>
                Confirm
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="danger"
            className="mt-4"
            iconLeft={<Trash size={16} />}
            onClick={() => setConfirmDelete(true)}
          >
            Delete account
          </Button>
        )}
      </section>
    </div>
  );
}
