"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@/shared/utils/cn";
import { SIDEBAR_SECTIONS, getSectionItems } from "@/shared/constants/sidebarVisibility";

// Settings tabs are derived from the sidebar CONFIGURATION section — the same
// single source of truth the Sidebar and Header read, so order/labels/icons
// never drift between the two navigation surfaces.
const SETTINGS_TABS = SIDEBAR_SECTIONS.flatMap((section) => getSectionItems(section)).filter(
  (item) => !item.external && item.href.startsWith("/dashboard/settings/")
);

/**
 * SettingsShell — shared tab strip across the /dashboard/settings/* pages.
 * Every settings route wraps its content in this shell so cross-page
 * navigation works without opening the sidebar (essential on mobile).
 */
export default function SettingsShell({ children }: { children?: React.ReactNode }) {
  const pathname = usePathname();
  const t = useTranslations("sidebar");
  const getLabel = (key: string, fallback: string) =>
    typeof t.has === "function" && t.has(key) ? t(key) : fallback;

  return (
    <div className="flex flex-col gap-6">
      <nav
        aria-label={getLabel("settings", "Settings")}
        className="flex gap-1.5 overflow-x-auto custom-scrollbar -mx-1 px-1 pb-1"
      >
        {SETTINGS_TABS.map((tab) => {
          const active = pathname === tab.href || (pathname ?? "").startsWith(`${tab.href}/`);
          return (
            <Link
              key={tab.id}
              href={tab.href}
              prefetch={false}
              aria-current={active ? "page" : undefined}
              className={cn(
                "shrink-0 inline-flex items-center gap-1.5 h-8 px-3.5 rounded-full text-[13px] font-medium whitespace-nowrap",
                "transition-[background-color,color,transform] duration-200 ease-[var(--ease-spring-critical)] active:scale-[0.97]",
                active
                  ? "bg-primary text-white shadow-sm"
                  : "text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/5"
              )}
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                {tab.icon}
              </span>
              {getLabel(tab.i18nKey, tab.labelFallback ?? tab.id)}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
