// Etymos's social accounts, for the footer and the Contact page. Labels are
// functions so they follow the UI language at render time.
import { FacebookLogo, TiktokLogo } from "@phosphor-icons/react";
import { t } from "./i18n";

export const SOCIAL_LINKS = [
  {
    name: "Facebook",
    label: () => t("Etymos on Facebook"),
    href: "https://www.facebook.com/profile.php?id=61595158266498",
    Icon: FacebookLogo,
  },
  { name: "TikTok", label: () => t("Etymos on TikTok"), href: "https://www.tiktok.com/@etymosofficial", Icon: TiktokLogo },
];
