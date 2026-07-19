import { Link } from "react-router-dom";
import { cn } from "@etymos/shared";

export function LogoMark({ size = 32, onDark = false }: { size?: number; onDark?: boolean }) {
  // The white brand mark needs contrast to read on light backgrounds, so it
  // sits in a navy badge there; on already-dark nav/footer backgrounds it's
  // shown directly with no badge.
  if (onDark) {
    return (
      <img
        src="/assets/logo/etymos-mark-white.svg"
        alt=""
        width={size}
        height={size}
        className="shrink-0 object-contain"
      />
    );
  }
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-[10px] bg-navy-900"
      style={{ width: size, height: size }}
    >
      <img
        src="/assets/logo/etymos-mark-white.svg"
        alt=""
        width={size * 0.62}
        height={size * 0.62}
        className="object-contain"
      />
    </span>
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
      <LogoMark size={size} onDark={variant === "light"} />
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
