// Vietnamese catalog: { "English source text": "Bản dịch tiếng Việt" }.
// Merged from per-area files so each stays reviewable. Add new strings to the
// area that owns the screen; i18n.audit.test.ts fails if a `t("...")` string in
// the code has no entry here.
import { common } from "./vi/common";
import { components } from "./vi/components";
import { lib } from "./vi/lib";
import { documents } from "./vi/documents";
import { report } from "./vi/report";
import { landing } from "./vi/landing";
import { account } from "./vi/account";
import { billing } from "./vi/billing";

export const vi: Record<string, string> = {
  ...common,
  ...components,
  ...lib,
  ...documents,
  ...report,
  ...landing,
  ...account,
  ...billing,
};
