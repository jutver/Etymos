import { Outlet } from "react-router-dom";
import { Logo } from "./Logo";
import { ToastViewport } from "../ui/ToastViewport";

export function AuthShell() {
  return (
    <div className="flex min-h-dvh flex-col bg-surface-tint">
      <header className="px-5 py-6 sm:px-8">
        <Logo />
      </header>
      <div className="flex flex-1 items-center justify-center px-5 pb-16 sm:px-8">
        <div className="w-full max-w-md">
          <Outlet />
        </div>
      </div>
      <ToastViewport />
    </div>
  );
}
