import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase, useSupabaseSession } from "@etymos/shared";

type AdminRoleStatus = "loading" | "admin" | "not-admin";

/**
 * "verified": this session passed a second factor (JWT aal2). Admin powers in
 * the database and backend need that, so the dashboard waits for it.
 * "needs-code": an authenticator is set up, the code hasn't been entered yet.
 * "needs-setup": no authenticator yet.
 */
export type MfaStatus = "loading" | "verified" | "needs-code" | "needs-setup";

interface AdminAuthContextValue {
  session: Session | null;
  user: User | null;
  loading: boolean;
  roleStatus: AdminRoleStatus;
  isAdmin: boolean;
  mfaStatus: MfaStatus;
}

const AdminAuthContext = createContext<AdminAuthContextValue>({
  session: null,
  user: null,
  loading: true,
  roleStatus: "loading",
  isAdmin: false,
  mfaStatus: "loading",
});

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const { session, user, loading } = useSupabaseSession();
  const [roleStatus, setRoleStatus] = useState<AdminRoleStatus>("loading");
  const [mfaStatus, setMfaStatus] = useState<MfaStatus>("loading");
  const userId = user?.id ?? null;
  const accessToken = session?.access_token ?? null;

  // Keyed on the id, not the user object: coming back to the tab refreshes
  // the session, and re-checking the role then would blank the whole app.
  useEffect(() => {
    if (loading) return;
    if (!userId) {
      setRoleStatus("not-admin");
      return;
    }

    let cancelled = false;
    setRoleStatus("loading");

    supabase
      .from("profiles")
      .select("role")
      .eq("id", userId)
      .single()
      .then(({ data, error }) => {
        if (cancelled) return;
        setRoleStatus(!error && data?.role === "admin" ? "admin" : "not-admin");
      });

    return () => {
      cancelled = true;
    };
  }, [userId, loading]);

  // Read from the session token itself, so it's re-read when the token
  // changes (sign-in, refresh, a passed code). The previous value stays up in
  // the meantime, so a token refresh doesn't blank the app.
  useEffect(() => {
    if (loading) return;
    if (!accessToken) {
      setMfaStatus("loading");
      return;
    }
    let cancelled = false;
    supabase.auth.mfa.getAuthenticatorAssuranceLevel().then(({ data, error }) => {
      if (cancelled) return;
      if (error || !data) {
        setMfaStatus("needs-setup");
      } else if (data.currentLevel === "aal2") {
        setMfaStatus("verified");
      } else {
        setMfaStatus(data.nextLevel === "aal2" ? "needs-code" : "needs-setup");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [accessToken, loading]);

  const value: AdminAuthContextValue = {
    session,
    user,
    loading: loading || roleStatus === "loading" || (roleStatus === "admin" && mfaStatus === "loading"),
    roleStatus,
    isAdmin: roleStatus === "admin",
    mfaStatus,
  };

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

export function useAdminAuth() {
  return useContext(AdminAuthContext);
}
