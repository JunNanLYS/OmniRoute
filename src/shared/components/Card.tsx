"use client";

import { useCallback, useRef } from "react";
import { cn } from "@/shared/utils/cn";

interface CardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  children?: React.ReactNode;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: string;
  action?: React.ReactNode;
  padding?: "none" | "xs" | "sm" | "md" | "lg";
  hover?: boolean;
  className?: string;
}

export default function Card({
  children,
  title,
  subtitle,
  icon,
  action,
  padding = "md",
  hover = false,
  className,
  onMouseMove,
  ...props
}: CardProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const paddings = {
    none: "",
    xs: "p-3",
    sm: "p-4",
    md: "p-6",
    lg: "p-8",
  };

  // Apple spotlight sweep — the ::before in `.apple-card-spotlight` paints a
  // radial highlight under the content; only interactive cards track the pointer.
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (hover) {
        const el = ref.current;
        if (el) {
          const r = el.getBoundingClientRect();
          el.style.setProperty("--mx", `${e.clientX - r.left}px`);
          el.style.setProperty("--my", `${e.clientY - r.top}px`);
        }
      }
      onMouseMove?.(e);
    },
    [hover, onMouseMove]
  );

  return (
    <div
      ref={ref}
      className={cn(
        // Material stays expressed as Tailwind utilities so tailwind-merge can
        // still resolve consumer className overrides against them.
        "bg-surface border border-border rounded-card shadow-soft",
        "transition-[transform,box-shadow,border-color] duration-300 ease-[var(--ease-spring-critical)]",
        hover &&
          "apple-card-spotlight cursor-pointer hover:-translate-y-0.5 hover:shadow-elevated hover:border-primary/20 active:translate-y-0 active:scale-[0.995]",
        paddings[padding],
        className
      )}
      onMouseMove={handleMouseMove}
      {...props}
    >
      {(title || action) && (
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            {icon && (
              <div className="p-2 rounded-control bg-bg text-text-muted">
                <span className="material-symbols-outlined text-[20px]">{icon}</span>
              </div>
            )}
            <div>
              {title && <h3 className="text-text-main font-semibold">{title}</h3>}
              {subtitle && <p className="text-sm text-text-muted">{subtitle}</p>}
            </div>
          </div>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

interface CardSectionProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
}

// Sub-component: Bordered section inside Card
Card.Section = function CardSection({ children, className, ...props }: CardSectionProps) {
  return (
    <div
      className={cn(
        "p-4 rounded-control",
        "bg-black/[0.02] dark:bg-white/[0.02]",
        "border border-border",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
};

interface CardRowProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
}

// Sub-component: Hoverable row inside Card
Card.Row = function CardRow({ children, className, ...props }: CardRowProps) {
  return (
    <div
      className={cn(
        "p-3 -mx-3 px-3 transition-colors",
        "border-b border-border last:border-b-0",
        "hover:bg-black/[0.02] dark:hover:bg-white/[0.02]",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
};

interface CardListItemProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
  actions?: React.ReactNode;
}

// Sub-component: List item with hover actions (macOS style)
Card.ListItem = function CardListItem({
  children,
  actions,
  className,
  ...props
}: CardListItemProps) {
  return (
    <div
      className={cn(
        "group flex items-center justify-between p-3 -mx-3 px-3",
        "border-b border-black/[0.03] dark:border-white/[0.03] last:border-b-0",
        "hover:bg-black/[0.02] dark:hover:bg-white/[0.02]",
        "transition-colors",
        className
      )}
      {...props}
    >
      <div className="flex-1 min-w-0">{children}</div>
      {actions && (
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          {actions}
        </div>
      )}
    </div>
  );
};
