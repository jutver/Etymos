import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { stableUser, supabase } from "@etymos/shared";
import { t } from "./i18n";

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  loading: boolean;
}

const AuthContext = createContext<AuthContextValue>({ session: null, user: null, loading: true });

/**
 * The auth params Supabase put in the URL this page was opened with (email
 * verification links, OAuth returns). Captured once at module load because
 * supabase-js strips a successful `#access_token=…` from the URL while it
 * initialises, which happens before a lazy-loaded screen gets to render.
 * Error params (`#error_code=otp_expired`) are left in place, but reading
 * both from one snapshot keeps callers simple.
 */
export const initialAuthRedirect = (() => {
  if (typeof window === "undefined") return { hasSession: false, type: null, errorCode: null, errorDescription: null };
  const params = new URLSearchParams(window.location.search);
  new URLSearchParams(window.location.hash.slice(1)).forEach((value, key) => params.set(key, value));
  const hasError = params.has("error") || params.has("error_code") || params.has("error_description");
  return {
    hasSession: !hasError && (params.has("access_token") || params.has("code")),
    /** "signup", "recovery", "email_change", "magiclink"... — which email link this was. */
    type: params.get("type"),
    errorCode: hasError ? (params.get("error_code") ?? params.get("error") ?? "unknown") : null,
    errorDescription: params.get("error_description"),
  };
})();

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  // Same object while the user is unchanged (see stableUser), so screens
  // that refetch on `user` don't reload every time the tab regains focus.
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

  // Presence heartbeat (CHANGES_I_WANT.md Admin Portal #2 — "see whether
  // user is online in web app or not"). Writes `last_seen_at` on the user's
  // own row every 60s, plus once immediately, for as long as they have the
  // app open and signed in. `last_seen_at` is deliberately excluded from the
  // profile self-privilege-escalation trigger (see the ban/delete/presence
  // migration), so this plain self-update is allowed even for e.g. a banned
  // user's stray in-flight tab. Best-effort: a failed heartbeat just means
  // the admin sees this user as offline a little longer, nothing else reads
  // or depends on it client-side.
  useEffect(() => {
    const userId = session?.user?.id;
    if (!userId) return;

    function heartbeat() {
      supabase
        .from("profiles")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("id", userId as string)
        .then(({ error }) => {
          if (error) console.warn("Presence heartbeat failed:", error.message);
        });
    }

    heartbeat();
    const interval = window.setInterval(heartbeat, 60_000);
    return () => window.clearInterval(interval);
  }, [session?.user?.id]);

  return (
    <AuthContext.Provider value={{ session, user, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

/** First non-blank string among the given user_metadata keys. */
function metadataString(user: User, keys: string[]): string | null {
  for (const key of keys) {
    const value = user.user_metadata?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** A name the user saved wins; otherwise the Google account's name
 * (`full_name` / `name`, set by Supabase's Google provider). */
export function displayNameFor(user: User | null): string {
  if (!user) return "";
  return metadataString(user, ["display_name", "full_name", "name"]) || user.email?.split("@")[0] || t("Etymos user");
}

/** The Google account's profile photo, if the user signed in with Google. */
export function avatarUrlFor(user: User | null): string | null {
  if (!user) return null;
  return metadataString(user, ["avatar_url", "picture"]);
}

export function initialsFor(user: User | null): string {
  const name = displayNameFor(user);
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
