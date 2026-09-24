export * from "@etymos/shared";
import { currentLocale } from "./i18n";

/** Like the shared formatDate, but follows the UI language: "22 thg 9, 2026" / "22 Sep 2026". */
export function formatDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return new Intl.DateTimeFormat(currentLocale() === "vi-VN" ? "vi-VN" : "en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(d);
}
