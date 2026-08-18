"use client";

import { useTranslations } from "next-intl";
import RoutingStrategyCard from "../components/RoutingStrategyCard";
import RoutingTab from "../components/RoutingTab";
import ModelRoutingSection from "@/shared/components/ModelRoutingSection";
import ComboDefaultsTab from "../components/ComboDefaultsTab";
import FallbackChainsEditor from "../components/FallbackChainsEditor";
import ModelAliasesUnified from "../components/ModelAliasesUnified";
import BackgroundDegradationTab from "../components/BackgroundDegradationTab";
import ReasoningRoutingRules from "@/shared/components/ReasoningRoutingRules";
import SettingsShell from "../components/SettingsShell";

export default function SettingsRoutingPage() {
  const t = useTranslations("settings");
  return (
    <SettingsShell>
      <div className="space-y-6">
        <p className="text-sm text-text-muted">{t("routingSettingsIntro")}</p>
        <RoutingStrategyCard />
        <ComboDefaultsTab />
        <ReasoningRoutingRules />
        <ModelAliasesUnified />
        <FallbackChainsEditor />
        <ModelRoutingSection />
        <RoutingTab />
        <BackgroundDegradationTab />
      </div>
    </SettingsShell>
  );
}
