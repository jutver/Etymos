import { ApiError, type SupportCategory, type SupportStatus } from "../../lib/api";
import { t, tr } from "../../lib/i18n";

/** The one public support address (a real OneMail mailbox; the inbound
 * poller turns mail to it into tickets). */
export const SUPPORT_EMAIL = "support@etymos.site";

export const CATEGORY_LABELS: Record<SupportCategory, string> = {
  billing: tr("Billing and payments"),
  account: tr("Account and login"),
  checks: tr("Checks and reports"),
  bug: tr("Something isn't working"),
  other: tr("Other"),
};

/** Worded from the requester's side: "open" means it's with us. */
export const STATUS_LABELS: Record<SupportStatus, string> = {
  open: tr("Waiting for support"),
  pending: tr("Waiting for your reply"),
  resolved: tr("Resolved"),
  closed: tr("Closed"),
};

export const STATUS_CLASSES: Record<SupportStatus, string> = {
  open: "bg-brand-100 text-brand-700",
  pending: "bg-severity-moderate-bg text-severity-moderate",
  resolved: "bg-success-bg text-success",
  closed: "bg-surface-muted text-ink-500",
};

const ERRORS: Record<string, string> = {
  invalid_email: tr("Enter a valid email address."),
  invalid_subject: tr("Add a subject."),
  invalid_body: tr("Write a message."),
  body_too_long: tr("Your message is too long (10,000 characters at most)."),
  invalid_category: tr("Choose a topic."),
  too_many_files: tr("Attach up to 5 files."),
  file_too_large: tr("Each file must be 5 MB or smaller."),
  file_type: tr("Only images (PNG, JPG, GIF, WebP) and PDFs can be attached."),
  too_many_requests: tr("Too many requests from this address. Please try again in an hour."),
  closed: tr("This request is closed. Open a new one if you still need help."),
  not_found: tr("We couldn't find this request."),
};

export function supportErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (ERRORS[err.message]) return t(ERRORS[err.message]);
    if (err.status === 429) return t("Too many requests. Please wait a moment and try again.");
  }
  if (err instanceof TypeError) return t("Couldn't reach Etymos. Check your connection and try again.");
  return err instanceof Error ? err.message : t("Something went wrong.");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
