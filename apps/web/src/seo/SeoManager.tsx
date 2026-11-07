import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useLanguage } from "../lib/i18n";
import { applyPageMeta } from "./meta";

/** Updates <head> for the current route and language (see ./meta.ts). */
export function SeoManager() {
  const { pathname } = useLocation();
  const language = useLanguage();
  useEffect(() => {
    applyPageMeta(pathname, language);
  }, [pathname, language]);
  return null;
}
