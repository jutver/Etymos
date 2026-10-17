import { useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "./supabase";

export interface SupabaseSession {
  session: Session | null;
  user: User | null;
  loading: boolean;
}

/**
 * `next`, or `prev` when it describes the same user unchanged. supabase-js
 * re-checks the session whenever the tab becomes visible again and emits
 * SIGNED_IN / TOKEN_REFRESHED with a fresh `user` object for the same person;
 * keeping the old reference stops every effect that depends on `user` from
 * re-running (refetching, or re-checking the admin role and blanking the app).
 */
export function stableUser(prev: User | null, next: User | null): User | null {
  if (prev && next && prev.id === next.id && JSON.stringify(prev) === JSON.stringify(next)) return prev;
  return next;
}

export function useSupabaseSession(): SupabaseSession {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    function apply(newSession: Session | null) {
      setSession(newSession);
      setUser((prev) => stableUser(prev, newSession?.user ?? null));
      setLoading(false);
    }

    supabase.auth.getSession().then(({ data }) => apply(data.session));

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => apply(newSession));

    return () => listener.subscription.unsubscribe();
  }, []);

  return { session, user, loading };
}
