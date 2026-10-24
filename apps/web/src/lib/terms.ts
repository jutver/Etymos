// Terms of Service versioning and consent (supabase/migrations/20261024000000_terms_acceptances.sql).
//
// TERMS_VERSION is the date the policy set last changed. Bump it whenever any
// document in components/legal/policies changes in substance: every signed-in
// user is then asked to accept again (components/legal/TermsGate.tsx), and the
// legal pages show it as "Last updated".
import { supabase } from "@etymos/shared";
import { currentLocale } from "./i18n";

export const TERMS_VERSION = "2026-10-24";

export interface TermsStatus {
  /** Accepted the current version. */
  accepted: boolean;
  /** Accepted an earlier version, so this is an update rather than a first ask. */
  acceptedBefore: boolean;
}

export async function fetchTermsStatus(userId: string): Promise<TermsStatus> {
  const { data, error } = await supabase.from("terms_acceptances").select("version").eq("user_id", userId);
  if (error) throw error;
  const versions = (data ?? []).map((row) => row.version as string);
  return { accepted: versions.includes(TERMS_VERSION), acceptedBefore: versions.length > 0 };
}

export async function acceptTerms(): Promise<void> {
  const { error } = await supabase.rpc("accept_terms", { p_version: TERMS_VERSION });
  if (error) throw error;
}

/** "24 October 2026" / "24 tháng 10, 2026", in the UI language. */
export function termsDate(): string {
  return new Date(`${TERMS_VERSION}T00:00:00Z`).toLocaleDateString(currentLocale(), {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
