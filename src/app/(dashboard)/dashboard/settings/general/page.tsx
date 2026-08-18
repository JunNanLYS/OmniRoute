"use client";

import SystemStorageTab from "../components/SystemStorageTab";
import SettingsShell from "../components/SettingsShell";

export default function SettingsStoragePage() {
  return (
    <SettingsShell>
      <SystemStorageTab />
    </SettingsShell>
  );
}
