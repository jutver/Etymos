import { Suspense, useLayoutEffect, useRef } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { AppNav } from "./AppNav";
import { ToastViewport } from "../ui/ToastViewport";
import { PageLoader } from "../ui/PageLoader";
import { useShowSplash, useSplashOnEnter } from "../BootSplash";

export function AppShell() {
  const { pathname } = useLocation();
  // Opening a report gets the splash. It's triggered here rather than in the
  // report screen so it also covers that screen's chunk download (the
  // Suspense fallback below holds it); the screen then holds it until the
  // document has loaded. Moving between reports doesn't re-trigger it.
  useSplashOnEnter(pathname.startsWith("/report/"));

  // Going home from a report gets it too. Only that hop — leaving a report
  // for the paywall, say, doesn't.
  const showSplash = useShowSplash();
  const prevPath = useRef(pathname);
  useLayoutEffect(() => {
    if (prevPath.current.startsWith("/report/") && pathname === "/upload") showSplash();
    prevPath.current = pathname;
  }, [pathname, showSplash]);

  return (
    <div className="workspace-shell lg:pl-60 min-h-dvh bg-surface-tint">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <AppNav />
      {/* Boundary sits inside the shell so the nav stays mounted while a
          lazily-loaded route chunk is in flight. */}
      <main id="main-content" tabIndex={-1}>
        <Suspense fallback={<PageLoader />}>
          <Outlet />
        </Suspense>
      </main>
      <ToastViewport />
    </div>
  );
}
