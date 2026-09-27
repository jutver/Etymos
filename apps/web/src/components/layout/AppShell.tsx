import { Suspense } from "react";
import { Outlet } from "react-router-dom";
import { AppNav } from "./AppNav";
import { ToastViewport } from "../ui/ToastViewport";
import { PageLoader } from "../ui/PageLoader";

export function AppShell() {
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
