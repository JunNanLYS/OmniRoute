"use client";

import { forwardRef } from "react";
import { cn } from "@/shared/utils/cn";

// primary uses the .apple-btn-primary material (brand gradient + inset
// highlight + brand-tinted hover shadow) from the fork-only Apple layer in
// globals.css — single source of truth shared with the AppleButton alias.
const variants = {
  primary: "apple-btn-primary text-white",
  accent: "bg-accent text-white shadow-sm hover:bg-accent-hover",
  secondary:
    "bg-white dark:bg-white/10 border border-black/10 dark:border-white/10 text-text-main hover:bg-black/5 dark:hover:bg-white/5",
  outline: "border border-black/15 dark:border-white/15 text-text-main hover:bg-black/5",
  ghost: "text-text-muted hover:bg-black/5 dark:hover:bg-white/5 hover:text-text-main",
  warning: "bg-amber-500 text-white hover:bg-amber-600 shadow-sm",
  danger: "bg-red-500 text-white hover:bg-red-600 shadow-sm",
};

export type ButtonVariant = keyof typeof variants;
export type ButtonShape = "control" | "pill";
export type ButtonSize = "sm" | "md" | "lg";

// Radius lives inside the size map so `shape` swaps it structurally —
// tailwind-merge cannot dedupe custom `rounded-control` against `rounded-full`.
const sizes = (shape: ButtonShape): Record<ButtonSize, string> => ({
  sm: shape === "pill" ? "h-7 px-4 text-xs rounded-full" : "h-7 px-3 text-xs rounded-control",
  md: shape === "pill" ? "h-9 px-5 text-sm rounded-full" : "h-9 px-4 text-sm rounded-control",
  lg: shape === "pill" ? "h-11 px-7 text-sm rounded-full" : "h-11 px-6 text-sm rounded-control",
});

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children?: React.ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** "control" (dashboard forms, default) or "pill" (marketing/hero CTAs). */
  shape?: ButtonShape;
  /** Material Symbols name (string) or any ReactNode icon. */
  icon?: React.ReactNode;
  iconRight?: React.ReactNode;
  loading?: boolean;
  fullWidth?: boolean;
  className?: string;
}

function renderIcon(icon: React.ReactNode, ariaHidden = true) {
  if (icon == null) return null;
  if (typeof icon === "string") {
    return (
      <span
        className="material-symbols-outlined text-[18px] pointer-events-none"
        aria-hidden={ariaHidden}
      >
        {icon}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center pointer-events-none" aria-hidden={ariaHidden}>
      {icon}
    </span>
  );
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    children,
    variant = "primary",
    size = "md",
    shape = "control",
    icon,
    iconRight,
    disabled = false,
    loading = false,
    fullWidth = false,
    className,
    ...props
  },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "inline-flex items-center justify-center gap-2 font-medium cursor-pointer",
        // Apple fluid interface: feedback on pointer-down (not release) with a
        // critically-damped spring — interruptible, never a fixed keyframe.
        "transition-[transform,background-color,border-color,box-shadow,color,filter] duration-200 ease-[var(--ease-spring-critical)]",
        "active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100",
        variants[variant],
        sizes(shape)[size],
        fullWidth && "w-full",
        className
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <span
          className="material-symbols-outlined animate-spin text-[18px] pointer-events-none"
          aria-hidden="true"
        >
          progress_activity
        </span>
      ) : (
        renderIcon(icon)
      )}
      {children}
      {iconRight != null && !loading && renderIcon(iconRight)}
    </button>
  );
});

export default Button;
