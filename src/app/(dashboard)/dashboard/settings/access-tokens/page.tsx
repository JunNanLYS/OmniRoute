"use client";

import AccessTokensTab from "../components/AccessTokensTab";
import SettingsShell from "../components/SettingsShell";

export default function SettingsAccessTokensPage() {
  return (
    <SettingsShell>
      <AccessTokensTab />
    </SettingsShell>
  );
}
