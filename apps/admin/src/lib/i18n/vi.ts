// Vietnamese catalog for the admin portal: { "English source text": "Bản dịch tiếng Việt" }.
// i18n.audit.test.ts fails if a t("...") string in the code has no entry here.
import { common } from "./vi/common";
import { admin } from "./vi/admin";
import { support } from "./vi/support";

export const vi: Record<string, string> = {
  ...common,
  ...admin,
  ...support,
};
