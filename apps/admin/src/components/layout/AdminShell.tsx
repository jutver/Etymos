import { Outlet } from "react-router-dom";
import { AdminNav } from "./AdminNav";

export function AdminShell() {
  return (
    <div className="flex min-h-dvh bg-bg">
      <AdminNav />
      <main className="min-w-0 flex-1 overflow-x-auto px-8 py-6">
        <Outlet />
      </main>
    </div>
  );
}
