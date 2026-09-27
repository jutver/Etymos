import { Suspense } from "react";
import { Outlet } from "react-router-dom";
import { Logo } from "./Logo";
import { ToastViewport } from "../ui/ToastViewport";
import { PageLoader } from "../ui/PageLoader";

export function AuthShell() {
  return (
    <div className="studio-auth auth-editorial flex min-h-dvh flex-col bg-surface-tint">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="relative z-10 px-5 py-6 sm:px-8">
        <Logo />
      </header>
      <main id="main-content" tabIndex={-1} className="auth-editorial-layout flex flex-1 items-center justify-center px-5 pb-16 sm:px-8">
        <aside className="auth-editorial-story">
          <p className="editorial-kicker">THE ORIGINALITY STUDIO</p>
          <h1>Your writing.<br /><em>Your own voice.</em></h1>
          <p>Vietnamese-first plagiarism detection, with the clarity to understand every match.</p>
          <img src="/assets/design/research-still-life.webp" width="1536" height="1024" alt="Open books and layered paper in warm sunlight" />
        </aside>
        <div className="studio-auth-card w-full max-w-lg">
          {/* Narrow column, so the loader fills the card slot rather than the
              viewport — the logo header stays visible above it. */}
          <Suspense fallback={<PageLoader fill="inline" />}>
            <Outlet />
          </Suspense>
        </div>
      </main>
      <ToastViewport />
    </div>
  );
}
