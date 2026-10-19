import { Suspense } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Logo } from "./Logo";
import { ToastViewport } from "../ui/ToastViewport";
import { PageLoader } from "../ui/PageLoader";
import { LanguageSwitcher } from "../LanguageSwitcher";
import { useSplashHold, useSplashOnMount } from "../BootSplash";
import { t } from "../../lib/i18n";

/** Screens that open with the splash when reached from outside this shell —
 * the landing page's Get Started, the nav's Log in. Moving between them
 * inside the shell keeps it mounted, so that doesn't re-trigger it. */
const SPLASH_PATHS = ["/login", "/signup"];

function AuthScreenFallback() {
  // Keeps the splash up until the form's chunk has loaded; never brings it back.
  useSplashHold(true, { reshow: false });
  return <PageLoader fill="inline" />;
}

export function AuthShell() {
  const { pathname } = useLocation();
  useSplashOnMount(SPLASH_PATHS.includes(pathname));

  return (
    <div className="studio-auth auth-editorial flex min-h-dvh flex-col bg-surface-tint">
      <header className="flex items-center justify-between px-5 py-6 sm:px-8">
        <Logo />
        <LanguageSwitcher />
      </header>
      <main id="main-content" tabIndex={-1} className="auth-editorial-layout flex flex-1 items-center justify-center px-5 pb-16 sm:px-8">
        <aside className="auth-editorial-story">
          <p className="editorial-kicker">{t("THE ORIGINALITY STUDIO")}</p>
          <h1>{t("Your writing.")}<br /><em>{t("Your own voice.")}</em></h1>
          <p>{t("Vietnamese-first plagiarism detection, with the clarity to understand every match.")}</p>
          <img src="/assets/design/research-still-life.webp" width="1536" height="1024" alt={t("Open books and layered paper in warm sunlight")} />
        </aside>
        <div className="studio-auth-card w-full max-w-lg">
          {/* Narrow column, so the loader fills the card slot rather than the
              viewport — the logo header stays visible above it. */}
          <Suspense fallback={<AuthScreenFallback />}>
            <Outlet />
          </Suspense>
        </div>
      </main>
      <ToastViewport />
    </div>
  );
}
