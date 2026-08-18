"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import Button, { type ButtonVariant } from "./Button";

/**
 * AppleButton — @deprecated thin alias over Button.
 *
 * Button absorbed the Apple fluid-interface behaviors (spring press on
 * pointer-down, brand primary material). Use Button directly:
 *
 *   <Button shape="pill" variant="secondary" icon={...}>…</Button>
 *
 * This alias is kept so existing call sites keep working unchanged;
 * variant/size/icon props map 1:1 onto Button's API.
 */
export type AppleButtonVariant = "primary" | "secondary" | "tertiary";
export type AppleButtonSize = "sm" | "md" | "lg";

interface AppleButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children?: ReactNode;
  variant?: AppleButtonVariant;
  size?: AppleButtonSize;
  icon?: ReactNode;
  trailingIcon?: ReactNode;
  loading?: boolean;
  className?: string;
}

const variantMap: Record<AppleButtonVariant, ButtonVariant> = {
  primary: "primary",
  secondary: "secondary",
  tertiary: "ghost",
};

const AppleButton = forwardRef<HTMLButtonElement, AppleButtonProps>(function AppleButton(
  { variant = "secondary", size = "md", icon, trailingIcon, ...props },
  ref
) {
  return (
    <Button
      ref={ref}
      shape="pill"
      variant={variantMap[variant]}
      size={size}
      icon={icon}
      iconRight={trailingIcon}
      {...props}
    />
  );
});

export default AppleButton;
