import { forwardRef } from "react";
import type { ButtonHTMLAttributes, AnchorHTMLAttributes, ReactNode } from "react";
import { Link, type LinkProps } from "react-router-dom";
import { CircleNotch } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] font-semibold whitespace-nowrap " +
  "transition-all duration-200 ease-out active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none disabled:active:scale-100 select-none";

const variants: Record<ButtonVariant, string> = {
  primary:
    "text-white brand-gradient shadow-[0_10px_24px_-8px_rgba(30,79,196,0.55)] hover:brightness-[1.08] hover:shadow-[0_14px_28px_-8px_rgba(30,79,196,0.65)]",
  secondary: "bg-navy-900 text-white hover:bg-navy-800",
  outline:
    "border border-line bg-white text-ink-900 hover:border-brand-400 hover:bg-brand-100/60",
  ghost: "text-ink-700 hover:bg-surface-muted",
  danger: "bg-severity-high text-white hover:brightness-110",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-9 px-3.5 text-sm",
  md: "h-11 px-5 text-[0.9375rem]",
  lg: "h-[3.25rem] px-7 text-base",
};

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  fullWidth?: boolean;
}

type ButtonAsButton = CommonProps &
  ButtonHTMLAttributes<HTMLButtonElement> & { as?: "button" };

type ButtonAsLink = CommonProps &
  Omit<LinkProps, "className"> & { as: "link"; className?: string };

type ButtonAsAnchor = CommonProps &
  AnchorHTMLAttributes<HTMLAnchorElement> & { as: "a" };

export type ButtonProps = ButtonAsButton | ButtonAsLink | ButtonAsAnchor;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>((props, ref) => {
  const {
    variant = "primary",
    size = "md",
    loading = false,
    iconLeft,
    iconRight,
    fullWidth = false,
    className,
    children,
    ...rest
  } = props as ButtonAsButton & { as?: string };

  const classes = cn(
    base,
    variants[variant],
    sizes[size],
    fullWidth && "w-full",
    className,
  );

  if (props.as === "link") {
    const { as: _as, ...linkRest } = rest as unknown as ButtonAsLink;
    return (
      <Link className={classes} {...linkRest}>
        {iconLeft}
        {children}
        {iconRight}
      </Link>
    );
  }

  if (props.as === "a") {
    const { as: _as, ...anchorRest } = rest as unknown as ButtonAsAnchor;
    return (
      <a className={classes} {...anchorRest}>
        {iconLeft}
        {children}
        {iconRight}
      </a>
    );
  }

  const buttonRest = rest as ButtonHTMLAttributes<HTMLButtonElement>;
  return (
    <button ref={ref} className={classes} disabled={loading || buttonRest.disabled} {...buttonRest}>
      {loading ? <CircleNotch size={18} weight="bold" className="animate-spin motion-reduce:animate-none" /> : iconLeft}
      {children}
      {!loading && iconRight}
    </button>
  );
});

Button.displayName = "Button";
