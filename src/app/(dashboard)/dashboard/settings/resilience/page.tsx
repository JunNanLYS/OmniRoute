"use client";

import { useTranslations } from "next-intl";
import ResilienceTab from "../components/ResilienceTab";
import SettingsShell from "../components/SettingsShell";

export default function SettingsResiliencePage() {
  const t = useTranslations("settings");
  return (
    <SettingsShell>
      <div className="space-y-6">
        <p className="text-sm text-text-muted">
          {t("resilienceSettingsIntro")} {t("resilienceStructureDesc")}
        </p>
        <ResilienceTab />
      </div>
    </SettingsShell>
  );
}
