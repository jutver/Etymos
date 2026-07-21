import { Suspense } from "react";
import { Outlet } from "react-router-dom";
import { PublicNav } from "./PublicNav";
import { Footer } from "./Footer";
import { ToastViewport } from "../ui/ToastViewport";
import { PageLoader } from "../ui/PageLoader";

export function PublicShell() {
  return (
    <div className="min-h-dvh bg-white">
      <PublicNav />
      {/* Nav and footer stay put while the route chunk loads. */}
      <Suspense fallback={<PageLoader />}>
        <Outlet />
      </Suspense>
      <Footer />
      <ToastViewport />
    </div>
  );
}
