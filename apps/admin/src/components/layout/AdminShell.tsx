import { Outlet } from "react-router-dom";
import { AdminNav } from "./AdminNav";

export function AdminShell() {
  return (
    <div className="flex min-h-dvh flex-col bg-bg md:flex-row">
      <AdminNav />
      <main className="min-w-0 flex-1 overflow-x-auto px-4 py-5 sm:px-6 md:px-8 md:py-6">
        <Outlet />
      </main>
    </div>
  );
}
