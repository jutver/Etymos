import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { List, X } from "@phosphor-icons/react";
import { Logo } from "./Logo";
import { Button } from "../ui/Button";

const links = [
  { label: "Features", href: "/#features" },
  { label: "How it works", href: "/#how-it-works" },
  { label: "Pricing", href: "/pricing" },
];

export function PublicNav() {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  return (
    <header className="public-nav sticky top-0 z-40 border-b border-line/70 bg-white/85 backdrop-blur-md">
      <div className="mx-auto flex h-[80px] max-w-[1480px] items-center justify-between px-5 sm:px-8">
        <Logo />

        <nav aria-label="Primary navigation" className="hidden items-center gap-1 lg:flex">
          {links.map((l) => (
            <Link
              key={l.label}
              to={l.href}
              aria-current={location.pathname === l.href ? "page" : undefined}
              className="rounded-[var(--radius-input)] px-4 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-surface-muted hover:text-brand-600"
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="hidden items-center gap-3 lg:flex">
          <Button as="link" to="/login" variant="ghost" size="sm">
            Log in
          </Button>
          <Button as="link" to="/signup" size="sm">
            Get Started
          </Button>
        </div>

        <button
          className="flex size-11 items-center justify-center rounded-[var(--radius-input)] text-ink-700 hover:bg-surface-muted lg:hidden"
          onClick={() => setOpen((v) => !v)}
          aria-label="Toggle menu"
          aria-expanded={open}
          aria-controls="public-mobile-navigation"
        >
          {open ? <X size={22} /> : <List size={22} />}
        </button>
      </div>

      {open && (
        <div id="public-mobile-navigation" className="max-h-[calc(100dvh-80px)] overflow-y-auto border-t border-line bg-white px-5 py-4 lg:hidden">
          <nav aria-label="Primary navigation" className="flex flex-col gap-1">
            {links.map((l) => (
              <Link
                key={l.label}
                to={l.href}
                onClick={() => setOpen(false)}
                aria-current={location.pathname === l.href ? "page" : undefined}
                className="rounded-[var(--radius-input)] px-3 py-2.5 text-sm font-medium text-ink-700 hover:bg-surface-tint"
              >
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="mt-3 flex flex-col gap-2">
            <Button as="link" to="/login" variant="outline" fullWidth onClick={() => setOpen(false)}>
              Log in
            </Button>
            <Button as="link" to="/signup" fullWidth onClick={() => setOpen(false)}>
              Get Started
            </Button>
          </div>
        </div>
      )}
      <span className="sr-only">{location.pathname}</span>
    </header>
  );
}
