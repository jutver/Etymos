import { Suspense } from "react";
import { Outlet } from "react-router-dom";
import { PublicNav } from "./PublicNav";
import { Footer } from "./Footer";
import { ToastViewport } from "../ui/ToastViewport";
import { PageLoader } from "../ui/PageLoader";

export function PublicShell() {
  return (
    <div className="public-shell min-h-dvh bg-white">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <PublicNav />
      {/* Nav and footer stay put while the route chunk loads. */}
      <main id="main-content" tabIndex={-1}>
        <Suspense fallback={<PageLoader />}>
          <Outlet />
        </Suspense>
      </main>
      <Footer />
      <ToastViewport />
    </div>
  );
}
