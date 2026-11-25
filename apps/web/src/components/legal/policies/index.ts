// The policy set users accept as one version (lib/terms.ts TERMS_VERSION).
// Changing any of these documents in substance means bumping that version.
import { TERMS } from "./terms";
import { PRIVACY } from "./privacy";
import { PAYMENT } from "./payment";
import { REFUND } from "./refund";
import { COMPLAINT } from "./complaint";
import { PLANS } from "./plans";
import type { Policy } from "./types";
import { OWNER_NAME, OWNER_ADDRESS, POLICY_PARAMS, POLICY_ROUTES } from "./meta";

export type { Policy, PolicyBlock, PolicySlug } from "./types";
export { TERMS, OWNER_NAME, OWNER_ADDRESS, POLICY_PARAMS, POLICY_ROUTES };

/** In reading order, as listed in the footer and the legal pages' sidebar. */
export const POLICIES: Policy[] = [TERMS, PRIVACY, PAYMENT, REFUND, COMPLAINT, PLANS];
