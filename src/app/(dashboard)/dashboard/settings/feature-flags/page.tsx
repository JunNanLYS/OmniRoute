"use client";

import FeatureFlagsGrid from "../components/FeatureFlagsGrid";
import SettingsShell from "../components/SettingsShell";

export default function FeatureFlagsPage() {
  return (
    <SettingsShell>
      <FeatureFlagsGrid />
    </SettingsShell>
  );
}
