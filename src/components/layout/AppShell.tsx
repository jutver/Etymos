import { Outlet } from "react-router-dom";
import { AppNav } from "./AppNav";
import { ToastViewport } from "../ui/ToastViewport";

export function AppShell() {
  return (
    <div className="min-h-dvh bg-surface-tint">
      <AppNav />
      <Outlet />
      <ToastViewport />
    </div>
  );
}
