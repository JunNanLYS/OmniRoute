"use client";

import DebugModeCard from "../components/DebugModeCard";
import LogToolSourcesCard from "../components/LogToolSourcesCard";
import PayloadRulesTab from "../components/PayloadRulesTab";
import RequestLimitsTab from "../components/RequestLimitsTab";
import CliproxyapiSettingsTab from "../components/CliproxyapiSettingsTab";
import SettingsShell from "../components/SettingsShell";

export default function SettingsAdvancedPage() {
  return (
    <SettingsShell>
      <div className="space-y-6">
        <DebugModeCard />
        <LogToolSourcesCard />
        <PayloadRulesTab />
        <RequestLimitsTab />
        <CliproxyapiSettingsTab />
      </div>
    </SettingsShell>
  );
}
