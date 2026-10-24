// One legal document (Terms, Privacy Policy, ...). Text is English source held
// with tr() and translated where it renders (components/legal/PolicyBody.tsx);
// Vietnamese lives in lib/i18n/vi/legal.ts. Strings may use {{owner}},
// {{address}} and {{email}}, filled in from POLICY_PARAMS.

export type PolicySlug = "terms" | "privacy" | "payment" | "refund" | "complaint" | "plans";

export type PolicyBlock =
  | { kind: "p"; text: string }
  | { kind: "h3"; text: string }
  | { kind: "note"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "steps"; items: { title: string; text: string }[] };

export interface Policy {
  slug: PolicySlug;
  path: string;
  title: string;
  /** One line for the policy list (sidebar, gate). */
  summary: string;
  intro: string[];
  sections: { title: string; blocks: PolicyBlock[] }[];
}
