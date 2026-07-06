import { Outlet } from "react-router-dom";
import { PublicNav } from "./PublicNav";
import { Footer } from "./Footer";
import { ToastViewport } from "../ui/ToastViewport";

export function PublicShell() {
  return (
    <div className="min-h-dvh bg-white">
      <PublicNav />
      <Outlet />
      <Footer />
      <ToastViewport />
    </div>
  );
}
