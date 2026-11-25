import { SUPPORT_EMAIL } from "../../support/labels";
import { tr } from "../../../lib/i18n";
import type { PolicySlug } from "./types";

/** The individual who operates Etymos, as named in the policies (Vietnamese
 * consumer law expects the seller to be identifiable). */
export const OWNER_NAME = "Phùng Nguyễn Phương Thảo";
export const OWNER_ADDRESS = "Lô E2a-7, Đường D1, Khu Công nghệ cao, Phường Tăng Nhơn Phú, TP.HCM";

export const POLICY_PARAMS = { owner: OWNER_NAME, address: OWNER_ADDRESS, email: SUPPORT_EMAIL };

/** Lightweight route & label metadata shared by App, Footer, and TermsGate so
 * full policy bodies load only when a user opens a legal page or TermsGate opens. */
export const POLICY_ROUTES: readonly { slug: PolicySlug; path: string; title: string }[] = [
  { slug: "terms", path: "/terms", title: tr("Terms of Service") },
  { slug: "privacy", path: "/privacy-policy", title: tr("Privacy Policy") },
  { slug: "payment", path: "/payment-policy", title: tr("Payment Policy") },
  { slug: "refund", path: "/refund-policy", title: tr("Refund Policy") },
  { slug: "complaint", path: "/complaint-policy", title: tr("Complaint Policy") },
  { slug: "plans", path: "/plans-and-credits", title: tr("Plans & credits") },
];
