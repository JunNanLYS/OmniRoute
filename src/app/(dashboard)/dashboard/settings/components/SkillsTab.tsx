"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import type { SkillsProvider } from "@/lib/skills/providerSettings";
import { Card } from "@/shared/components";

interface SkillsSettings {
  skillsEnabled: boolean;
  skillsmpApiKey: string;
  skillsProvider: SkillsProvider;
}

const DEFAULT_SKILLS_SETTINGS: SkillsSettings = {
  skillsEnabled: true,
  skillsmpApiKey: "",
  skillsProvider: "skillsmp",
};

export default function SkillsTab() {
  const [settings, setSettings] = useState(DEFAULT_SKILLS_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, "saved" | "error">>({});
  const t = useTranslations("settings");

  useEffect(() => {
    fetch("/api/settings")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!data || typeof data !== "object") return;
        setSettings((current) => ({
          skillsEnabled:
            typeof data.skillsEnabled === "boolean" ? data.skillsEnabled : current.skillsEnabled,
          skillsmpApiKey:
            typeof data.skillsmpApiKey === "string" ? data.skillsmpApiKey : current.skillsmpApiKey,
          skillsProvider:
            data.skillsProvider === "skillssh" || data.skillsProvider === "skillsmp"
              ? data.skillsProvider
              : current.skillsProvider,
        }));
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  const save = useCallback(async (updates: Partial<SkillsSettings>, key: string) => {
    setSaving(key);
    setStatus((current) => ({ ...current, [key]: undefined as never }));
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!response.ok) throw new Error("settings update failed");
      const data = await response.json().catch(() => updates);
      setSettings((current) => ({ ...current, ...updates, ...data }));
      setStatus((current) => ({ ...current, [key]: "saved" }));
      setTimeout(() => {
        setStatus((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
      }, 2000);
    } catch {
      setStatus((current) => ({ ...current, [key]: "error" }));
    } finally {
      setSaving(null);
    }
  }, []);

  const toggleSkills = useCallback(() => {
    const next = !settings.skillsEnabled;
    setSettings((current) => ({ ...current, skillsEnabled: next }));
    void save({ skillsEnabled: next }, "enabled");
  }, [save, settings.skillsEnabled]);

  if (loading) {
    return (
      <Card data-testid="skills-settings-card">
        <div className="text-sm text-text-muted">{t("loading")}...</div>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card data-testid="skills-settings-card">
        <div className="flex items-center gap-3 mb-5">
          <div className="p-2 rounded-lg bg-amber-500/10 text-amber-500">
            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
              handyman
            </span>
          </div>
          <div>
            <h3 className="text-lg font-semibold">{t("skillsTitle")}</h3>
            <p className="text-sm text-text-muted">{t("skillsDesc")}</p>
          </div>
          {status.enabled === "saved" && (
            <span className="ml-auto text-xs font-medium text-emerald-500">{t("saved")}</span>
          )}
          {status.enabled === "error" && (
            <span className="ml-auto text-xs font-medium text-red-500">
              {t("memorySkillsFailedToSave")}
            </span>
          )}
        </div>

        <div className="flex items-center justify-between p-4 rounded-lg bg-surface/30 border border-border/30">
          <div>
            <p className="text-sm font-medium">{t("skillsEnabled")}</p>
            <p className="text-xs text-text-muted mt-0.5">{t("skillsEnabledDesc")}</p>
          </div>
          <button
            data-testid="skills-enabled-switch"
            onClick={toggleSkills}
            disabled={saving === "enabled"}
            className={`relative w-11 h-6 rounded-full transition-colors ${
              settings.skillsEnabled ? "bg-amber-500" : "bg-border"
            }`}
            role="switch"
            aria-checked={settings.skillsEnabled}
          >
            <span
              className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full transition-transform ${
                settings.skillsEnabled ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </Card>

      <Card>
        <div className="flex items-center gap-3 mb-5">
          <div className="p-2 rounded-lg bg-blue-500/10 text-blue-500">
            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
              storefront
            </span>
          </div>
          <div>
            <h3 className="text-lg font-semibold">{t("memorySkillsSkillsmpMarketplace")}</h3>
            <p className="text-sm text-text-muted">SkillsMP marketplace credentials.</p>
          </div>
          {status.apiKey === "saved" && (
            <span className="ml-auto text-xs font-medium text-emerald-500">{t("saved")}</span>
          )}
          {status.apiKey === "error" && (
            <span className="ml-auto text-xs font-medium text-red-500">
              {t("memorySkillsFailedToSave")}
            </span>
          )}
        </div>

        <div className="p-4 rounded-lg bg-surface/30 border border-border/30">
          <label className="text-sm font-medium block mb-2">{t("memorySkillsApiKey")}</label>
          <div className="flex gap-2">
            <input
              type="password"
              value={settings.skillsmpApiKey}
              onChange={(event) =>
                setSettings((current) => ({ ...current, skillsmpApiKey: event.target.value }))
              }
              placeholder="sk_live_..."
              className="flex-1 px-3 py-2 rounded-lg bg-background border border-border text-sm font-mono focus:outline-none focus:ring-1 focus:ring-violet-500"
            />
            <button
              onClick={() => void save({ skillsmpApiKey: settings.skillsmpApiKey }, "apiKey")}
              disabled={saving === "apiKey"}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-50 transition-colors"
            >
              {saving === "apiKey" ? t("saving") : t("save")}
            </button>
          </div>
        </div>
      </Card>

      <Card>
        <div className="flex items-center gap-3 mb-5">
          <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-500">
            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
              hub
            </span>
          </div>
          <div>
            <h3 className="text-lg font-semibold">{t("memorySkillsActiveSkillsProvider")}</h3>
            <p className="text-sm text-text-muted">
              Choose the Skills search and install provider.
            </p>
          </div>
          {status.provider === "saved" && (
            <span className="ml-auto text-xs font-medium text-emerald-500">{t("saved")}</span>
          )}
          {status.provider === "error" && (
            <span className="ml-auto text-xs font-medium text-red-500">
              {t("memorySkillsFailedToSave")}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {(["skillsmp", "skillssh"] as const).map((provider) => (
            <button
              key={provider}
              type="button"
              disabled={saving === "provider"}
              onClick={() => {
                setSettings((current) => ({ ...current, skillsProvider: provider }));
                void save({ skillsProvider: provider }, "provider");
              }}
              className={`flex flex-col items-start p-3 rounded-lg border text-left transition-all ${
                settings.skillsProvider === provider
                  ? "border-indigo-500/50 bg-indigo-500/5 ring-1 ring-indigo-500/20"
                  : "border-border/50 hover:border-border hover:bg-surface/30"
              }`}
            >
              <p className="text-sm font-medium">
                {provider === "skillsmp" ? "SkillsMP Marketplace" : "skills.sh Directory"}
              </p>
              <p className="text-xs text-text-muted mt-0.5 leading-relaxed">
                {provider === "skillsmp"
                  ? "Authenticated marketplace using the configured API key."
                  : "Public directory provider; no API key required."}
              </p>
            </button>
          ))}
        </div>
      </Card>
    </div>
  );
}
