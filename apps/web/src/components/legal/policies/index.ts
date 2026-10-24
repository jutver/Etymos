// The policy set users accept as one version (lib/terms.ts TERMS_VERSION).
// Changing any of these documents in substance means bumping that version.
import { SUPPORT_EMAIL } from "../../support/labels";
import { TERMS } from "./terms";
import { PRIVACY } from "./privacy";
import { PAYMENT } from "./payment";
import { REFUND } from "./refund";
import { COMPLAINT } from "./complaint";
import { PLANS } from "./plans";
import type { Policy } from "./types";

export type { Policy, PolicyBlock, PolicySlug } from "./types";
export { TERMS };

/** The individual who operates Etymos, as named in the policies (Vietnamese
 * consumer law expects the seller to be identifiable). */
export const OWNER_NAME = "Phùng Nguyễn Phương Thảo";
export const OWNER_ADDRESS = "Lô E2a-7, Đường D1, Khu Công nghệ cao, Phường Tăng Nhơn Phú, TP.HCM";

export const POLICY_PARAMS = { owner: OWNER_NAME, address: OWNER_ADDRESS, email: SUPPORT_EMAIL };

/** In reading order, as listed in the footer and the legal pages' sidebar. */
export const POLICIES: Policy[] = [TERMS, PRIVACY, PAYMENT, REFUND, COMPLAINT, PLANS];
