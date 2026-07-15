import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase, useSupabaseSession } from "@etymos/shared";

type AdminRoleStatus = "loading" | "admin" | "not-admin";

interface AdminAuthContextValue {
  session: Session | null;
  user: User | null;
  loading: boolean;
  roleStatus: AdminRoleStatus;
  isAdmin: boolean;
}

const AdminAuthContext = createContext<AdminAuthContextValue>({
  session: null,
  user: null,
  loading: true,
  roleStatus: "loading",
  isAdmin: false,
});

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const { session, user, loading } = useSupabaseSession();
  const [roleStatus, setRoleStatus] = useState<AdminRoleStatus>("loading");

  useEffect(() => {
    if (loading) return;
    if (!user) {
      setRoleStatus("not-admin");
      return;
    }

    let cancelled = false;
    setRoleStatus("loading");

    supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single()
      .then(({ data, error }) => {
        if (cancelled) return;
        setRoleStatus(!error && data?.role === "admin" ? "admin" : "not-admin");
      });

    return () => {
      cancelled = true;
    };
  }, [user, loading]);

  const value: AdminAuthContextValue = {
    session,
    user,
    loading: loading || roleStatus === "loading",
    roleStatus,
    isAdmin: roleStatus === "admin",
  };

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

export function useAdminAuth() {
  return useContext(AdminAuthContext);
}
