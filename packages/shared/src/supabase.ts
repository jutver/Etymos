import { createClient } from "@supabase/supabase-js";

const url = (import.meta.env.VITE_SUPABASE_URL || "https://example.supabase.co") as string;
const publishableKey = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "demo-publishable-key") as string;

export const supabase = createClient(url, publishableKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});
