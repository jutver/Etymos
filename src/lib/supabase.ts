import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

export const supabase = createClient(url, publishableKey);

export const GOOGLE_MOCK_EMAIL = "google.demo@etymos.app";
export const GOOGLE_MOCK_PASSWORD = "etymos-google-mock-2026";
