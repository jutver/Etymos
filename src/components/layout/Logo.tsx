import { Link } from "react-router-dom";
import { cn } from "../../lib/cn";

export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className="shrink-0">
      <defs>
        <linearGradient id="logo-g" x1="4" y1="4" x2="44" y2="44" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#9FD2F0" />
          <stop offset="1" stopColor="#1E4FC4" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="12" fill="url(#logo-g)" />
      <path d="M15 14H33V19H20.5V21.8H31V26.6H20.5V29.6H33.3V34.4H15V14Z" fill="white" />
    </svg>
  );
}

export function Logo({
  variant = "default",
  to = "/",
  size = 30,
}: {
  variant?: "default" | "light";
  to?: string;
  size?: number;
}) {
  return (
    <Link to={to} className="inline-flex items-center gap-2.5">
      <LogoMark size={size} />
      <span
        className={cn(
          "text-lg font-bold tracking-tight",
          variant === "light" ? "text-white" : "text-navy-900",
        )}
      >
        Etymos
      </span>
    </Link>
  );
}
