"use client";

/**
 * /dashboard/memory — four-layer memory management + distillation settings.
 *
 * Tabs are URL-driven (`?tab=l0|l1|l2|l3|settings`) so reload/share preserves
 * the active surface, plus a `lineage` query that scopes the table to a list
 * of ids when arriving from a cross-layer link. The clear-filter × chip
 * removes `lineage` from the URL.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AppleButton, AppleSurface } from "@/shared/components";
import MemoryConceptCard from "./components/MemoryConceptCard";
import L0Tab from "./components/layers/L0Tab";
import L1Tab from "./components/layers/L1Tab";
import L2Tab from "./components/layers/L2Tab";
import L3Tab from "./components/layers/L3Tab";
import DistillationSettingsTab from "./components/layers/DistillationSettingsTab";

const TAB_IDS = ["l0", "l1", "l2", "l3", "settings"] as const;
type TabId = (typeof TAB_IDS)[number];

const TAB_LABEL_KEY: Record<TabId, string> = {
  l0: "tabs.l0",
  l1: "tabs.l1",
  l2: "tabs.l2",
  l3: "tabs.l3",
  settings: "tabs.settings",
};

interface MemoryOwnerOption {
  id: string;
  name: string;
}

function parseLineageFilter(raw: string | null): string[] | null {
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : null;
}

function MemoryPageContent() {
  const t = useTranslations("memory");
  const searchParams = useSearchParams();
  const router = useRouter();
  const rawTab = searchParams.get("tab") ?? "";
  const requestedOwnerApiKeyId = searchParams.get("apiKeyId") ?? "";
  const [ownerOptions, setOwnerOptions] = useState<MemoryOwnerOption[]>([]);
  const [ownersLoading, setOwnersLoading] = useState(true);
  const [ownersError, setOwnersError] = useState(false);
  const activeTab: TabId = (TAB_IDS as readonly string[]).includes(rawTab)
    ? (rawTab as TabId)
    : "l0";
  const lineage = useMemo(() => parseLineageFilter(searchParams.get("lineage")), [searchParams]);
  const ownerApiKeyId = useMemo(() => {
    if (ownerOptions.some((option) => option.id === requestedOwnerApiKeyId)) {
      return requestedOwnerApiKeyId;
    }
    return ownerOptions[0]?.id ?? "";
  }, [ownerOptions, requestedOwnerApiKeyId]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/keys?limit=100", {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("api_key_list_failed");
        return response.json() as Promise<{ keys?: unknown[] }>;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        const rows = Array.isArray(payload?.keys) ? payload.keys : [];
        setOwnerOptions(
          rows.flatMap((value): MemoryOwnerOption[] => {
            if (!value || typeof value !== "object") return [];
            const row = value as {
              id?: unknown;
              name?: unknown;
              isActive?: unknown;
              isBanned?: unknown;
            };
            if (typeof row.id !== "string" || row.isActive === false || row.isBanned === true) {
              return [];
            }
            return [{ id: row.id, name: typeof row.name === "string" ? row.name : row.id }];
          })
        );
        setOwnersError(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setOwnerOptions([]);
          setOwnersError(true);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setOwnersLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!ownerApiKeyId || requestedOwnerApiKeyId === ownerApiKeyId) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("apiKeyId", ownerApiKeyId);
    router.replace(`?${params.toString()}`, { scroll: false });
  }, [ownerApiKeyId, requestedOwnerApiKeyId, router, searchParams]);

  const setOwner = useCallback(
    (apiKeyId: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("apiKeyId", apiKeyId);
      params.delete("lineage");
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams]
  );

  const setTab = useCallback(
    (tab: TabId) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("tab", tab);
      // Lineage only applies to the L0/L1/L2 surfaces; clear it on switching
      // to L3 or settings so the chip does not leak across tabs.
      if (tab !== "l0" && tab !== "l1" && tab !== "l2") {
        params.delete("lineage");
      }
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams]
  );

  const clearLineage = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("lineage");
    router.replace(`?${params.toString()}`, { scroll: false });
  }, [router, searchParams]);

  return (
    <div className="space-y-6">
      <MemoryConceptCard />

      <AppleSurface className="p-4 sm:p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <label htmlFor="memory-owner-select" className="text-sm font-medium text-text-main">
              API key owner
            </label>
            <p className="mt-1 text-xs text-text-muted">
              Memory is isolated per API key. Select the owner to inspect and manage.
            </p>
          </div>
          {ownersLoading ? (
            <p className="text-xs text-text-muted" role="status">
              {t("common.loading")}
            </p>
          ) : ownersError ? (
            <p className="text-xs text-red-500" role="alert">
              Failed to load API keys
            </p>
          ) : ownerOptions.length === 0 ? (
            <p className="text-xs text-text-muted" data-testid="memory-owner-empty">
              No active API keys are available.
            </p>
          ) : (
            <select
              id="memory-owner-select"
              data-testid="memory-owner-select"
              value={ownerApiKeyId}
              onChange={(event) => setOwner(event.target.value)}
              className="min-w-[14rem] max-w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              {ownerOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name} · {option.id}
                </option>
              ))}
            </select>
          )}
        </div>
      </AppleSurface>

      <AppleSurface
        className="p-1.5 w-fit max-w-full"
        role="tablist"
        aria-label={t("tabs.tablist")}
      >
        <div className="flex gap-1 flex-wrap">
          {TAB_IDS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              data-testid={`tab-${tab}`}
              onClick={() => setTab(tab)}
              className={`px-3.5 py-1.5 rounded-full text-xs font-medium transition-colors ${
                activeTab === tab
                  ? "bg-primary text-white shadow-sm"
                  : "text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/5"
              }`}
            >
              {t(TAB_LABEL_KEY[tab])}
            </button>
          ))}
        </div>
      </AppleSurface>

      {lineage && (activeTab === "l0" || activeTab === "l1" || activeTab === "l2") && (
        <AppleSurface
          className="p-3 flex items-center justify-between gap-3"
          data-testid="lineage-chip"
        >
          <span className="text-xs text-text-muted truncate">
            {t("common.lineage")}: {lineage.join(", ")}
          </span>
          <AppleButton
            size="sm"
            variant="tertiary"
            onClick={clearLineage}
            data-testid="clear-lineage"
          >
            {t("clearFilters")}
          </AppleButton>
        </AppleSurface>
      )}

      {ownerApiKeyId ? (
        <div role="tabpanel" data-testid={`tabpanel-${activeTab}`}>
          {activeTab === "l0" && (
            <L0Tab initialSessionId={lineage?.[0] ?? null} apiKeyId={ownerApiKeyId} />
          )}
          {activeTab === "l1" && (
            <L1Tab lineageFilter={lineage} onClearLineage={clearLineage} apiKeyId={ownerApiKeyId} />
          )}
          {activeTab === "l2" && <L2Tab apiKeyId={ownerApiKeyId} />}
          {activeTab === "l3" && <L3Tab apiKeyId={ownerApiKeyId} />}
          {activeTab === "settings" && <DistillationSettingsTab apiKeyId={ownerApiKeyId} />}
        </div>
      ) : null}
    </div>
  );
}

export default function MemoryPage() {
  return (
    <Suspense fallback={<div className="h-64 flex items-center justify-center" />}>
      <MemoryPageContent />
    </Suspense>
  );
}
