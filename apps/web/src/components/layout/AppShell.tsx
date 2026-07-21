import { Suspense } from "react";
import { Outlet } from "react-router-dom";
import { AppNav } from "./AppNav";
import { ToastViewport } from "../ui/ToastViewport";
import { PageLoader } from "../ui/PageLoader";

export function AppShell() {
  return (
    <div className="min-h-dvh bg-surface-tint">
      <AppNav />
      {/* Boundary sits inside the shell so the nav stays mounted while a
          lazily-loaded route chunk is in flight. */}
      <Suspense fallback={<PageLoader />}>
        <Outlet />
      </Suspense>
      <ToastViewport />
    </div>
  );
}
