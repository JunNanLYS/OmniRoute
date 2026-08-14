import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-memory-pipeline-settings-"));
process.env["DATA_DIR"] = TEST_DATA_DIR;
process.env["DISABLE_SQLITE_AUTO_BACKUP"] = "true";
process.env["OMNIROUTE_MEMORY_CAPTURE_ENABLED"] = "false";
process.env["OMNIROUTE_MEMORY_INJECTION_ENABLED"] = "false";

const core = await import("../../src/memory/db/core.ts");
const operations = await import("../../src/memory/operations.ts");
const settings = await import("../../src/memory/integration/settings.ts");

test.after(() => {
  core.resetMemoryDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("per-key stored pipeline settings override environment defaults without leaking owners", () => {
  operations.upsertSetting(
    "pipeline.settings.per-key.owner-a",
    JSON.stringify({ captureEnabled: true, injectionEnabled: true })
  );

  const ownerA = settings.defaultMemoryPipelineSettingsResolver("owner-a");
  const ownerB = settings.defaultMemoryPipelineSettingsResolver("owner-b");

  assert.equal(ownerA.captureEnabled, true);
  assert.equal(ownerA.injectionEnabled, true);
  assert.equal(ownerB.captureEnabled, false);
  assert.equal(ownerB.injectionEnabled, false);
});
