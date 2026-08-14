import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const REMOVED_V3_MEMORY_UI = [
  "src/app/(dashboard)/dashboard/memory/components/EditMemoryModal.tsx",
  "src/app/(dashboard)/dashboard/memory/components/EmbeddingSourceSelector.tsx",
  "src/app/(dashboard)/dashboard/memory/components/MemoryEngineStatus.tsx",
  "src/app/(dashboard)/dashboard/memory/components/QdrantConfigCard.tsx",
  "src/app/(dashboard)/dashboard/memory/components/RerankConfigCard.tsx",
  "src/app/(dashboard)/dashboard/memory/components/RetrievePreview.tsx",
  "src/app/(dashboard)/dashboard/memory/hooks/useEngineStatus.ts",
  "src/app/(dashboard)/dashboard/memory/hooks/useMemorySettings.ts",
  "src/app/(dashboard)/dashboard/settings/components/MemorySkillsTab.tsx",
] as const;

const FOUR_LAYER_MEMORY_UI = [
  "src/app/(dashboard)/dashboard/memory/page.tsx",
  "src/app/(dashboard)/dashboard/memory/components/MemoryConceptCard.tsx",
  "src/app/(dashboard)/dashboard/memory/components/layers/L0Tab.tsx",
  "src/app/(dashboard)/dashboard/memory/components/layers/L1Tab.tsx",
  "src/app/(dashboard)/dashboard/memory/components/layers/L2Tab.tsx",
  "src/app/(dashboard)/dashboard/memory/components/layers/L3Tab.tsx",
  "src/app/(dashboard)/dashboard/memory/components/layers/DistillationSettingsTab.tsx",
  "src/app/(dashboard)/dashboard/settings/components/SkillsTab.tsx",
] as const;

const REMOVED_V3_MEMORY_RUNTIME = [
  "src/lib/memory",
  "src/app/api/settings/memory/route.ts",
  "src/app/api/settings/qdrant",
  "src/app/api/memory/embedding-providers/route.ts",
  "src/shared/schemas/memory.ts",
  "src/shared/schemas/qdrant.ts",
  "bin/cli/api-commands/memory.mjs",
] as const;

const FOUR_LAYER_MEMORY_RUNTIME = [
  "src/memory/api/dependencies.ts",
  "src/memory/db/core.ts",
  "src/memory/integration/runtime.ts",
  "src/memory/recall/facade.ts",
  "src/shared/schemas/memoryFourLayer.ts",
  "src/app/api/memory/l0/route.ts",
  "src/app/api/memory/l1/route.ts",
  "src/app/api/memory/l2/route.ts",
  "src/app/api/memory/l3/route.ts",
  "src/app/api/memory/distillation-model/route.ts",
] as const;

test("four-layer dashboard excludes the removed v3 memory engine UI", () => {
  for (const relativePath of REMOVED_V3_MEMORY_UI) {
    assert.equal(fs.existsSync(path.join(ROOT, relativePath)), false, relativePath);
  }
  for (const relativePath of FOUR_LAYER_MEMORY_UI) {
    assert.equal(fs.existsSync(path.join(ROOT, relativePath)), true, relativePath);
  }
});

test("four-layer runtime excludes the removed v3 memory engine", () => {
  for (const relativePath of REMOVED_V3_MEMORY_RUNTIME) {
    assert.equal(fs.existsSync(path.join(ROOT, relativePath)), false, relativePath);
  }
  for (const relativePath of FOUR_LAYER_MEMORY_RUNTIME) {
    assert.equal(fs.existsSync(path.join(ROOT, relativePath)), true, relativePath);
  }
});
