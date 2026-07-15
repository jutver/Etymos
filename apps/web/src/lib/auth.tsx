import { createContext, useContext, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { useSupabaseSession } from "@etymos/shared";

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  loading: boolean;
}

const AuthContext = createContext<AuthContextValue>({ session: null, user: null, loading: true });

export function AuthProvider({ children }: { children: ReactNode }) {
  const { session, user, loading } = useSupabaseSession();

  return (
    <AuthContext.Provider value={{ session, user, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

export function displayNameFor(user: User | null): string {
  if (!user) return "";
  return (user.user_metadata?.display_name as string) || user.email?.split("@")[0] || "Etymos user";
}

export function initialsFor(user: User | null): string {
  const name = displayNameFor(user);
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
