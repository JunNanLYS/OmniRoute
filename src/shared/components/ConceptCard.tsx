"use client";

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/shared/utils/cn";

/**
 * ConceptCard — shared "explainer" card (icon + title + description + a
 * collapsible details area). Consolidates the per-page ConceptCard copies
 * (memory / batch / files / quota-share / translator); only genuinely unique
 * shapes (comparison tables, concept grids) stay as dedicated components.
 *
 * Two toggle placements, same hiding semantics — `description` and `body`
 * always render, only `details` collapses:
 * - collapse="body"   → chevron in the header row (batch/files/quota style)
 * - collapse="details"→ inline text toggle under the header (memory/translator style)
 */
export interface ConceptCardProps {
  icon?: string;
  iconClassName?: string;
  title: ReactNode;
  description?: ReactNode;
  /** Always-visible content between header and the collapsible area. */
  body?: ReactNode;
  /** Content revealed by the toggle. */
  details?: ReactNode;
  /** Label for the inline toggle (collapse="details"). */
  toggleLabel?: ReactNode;
  collapse?: "details" | "body";
  defaultOpen?: boolean;
  /** localStorage key persisting the open state across visits. */
  persistKey?: string;
  className?: string;
}

export default function ConceptCard({
  icon,
  iconClassName,
  title,
  description,
  body,
  details,
  toggleLabel,
  collapse = "details",
  defaultOpen,
  persistKey,
  className,
}: ConceptCardProps) {
  const [open, setOpen] = useState(defaultOpen ?? collapse === "body");

  // Hydrate from localStorage after mount (avoids SSR mismatch).
  useEffect(() => {
    if (!persistKey) return;
    try {
      const stored = localStorage.getItem(persistKey);
      if (stored !== null) {
         
        setOpen(stored === "true");
      } else if (defaultOpen !== undefined) {
        setOpen(defaultOpen);
      }
    } catch {
      // localStorage unavailable (SSR/private mode) — keep default
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydrate once per key
  }, [persistKey]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (persistKey) {
      try {
        localStorage.setItem(persistKey, String(next));
      } catch {
        // ignore
      }
    }
  };

  const chevron = (
    <span
      className={cn(
        "material-symbols-outlined text-[14px] transition-transform duration-300 ease-[var(--ease-spring-critical)]",
        open ? "rotate-180" : "rotate-0"
      )}
      aria-hidden="true"
    >
      expand_more
    </span>
  );

  return (
    <div
      className={cn(
        "rounded-card border border-border bg-bg-subtle/50 p-4",
        "flex flex-col gap-3",
        className
      )}
    >
      {/* Header */}
      <div
        className={cn(
          "flex gap-3",
          collapse === "body" ? "items-center justify-between" : "items-start"
        )}
      >
        <div className="flex items-start gap-3 min-w-0">
          {icon && (
            <div
              className={cn(
                "p-2 rounded-control bg-primary/10 text-primary shrink-0",
                iconClassName
              )}
            >
              <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
                {icon}
              </span>
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-text-main">{title}</h2>
            {description && (
              <p className="text-xs text-text-muted mt-1 leading-relaxed">{description}</p>
            )}
          </div>
        </div>
        {collapse === "body" && (
          <button
            type="button"
            onClick={toggle}
            className="flex items-center gap-1 text-xs text-text-muted hover:text-text-main transition-colors shrink-0"
            aria-expanded={open}
          >
            {toggleLabel}
            {chevron}
          </button>
        )}
      </div>

      {body}

      {collapse === "details" && details && (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="mt-1 self-start inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          {toggleLabel}
          {chevron}
        </button>
      )}

      {open && details && (
        <div className="p-3 rounded-control bg-surface/50 border border-border/60 text-xs text-text-muted leading-relaxed">
          {details}
        </div>
      )}
    </div>
  );
}
