import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";

import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "omniroute-distillation-worker-settings-")
);
process.env["DATA_DIR"] = TEST_DATA_DIR;
process.env["DISABLE_SQLITE_AUTO_BACKUP"] = "true";

const memoryCore = await import("../../../../src/memory/db/core.ts");
const runtime = await import("../../../../src/memory/integration/distillationWorkerSettings.ts");

test.after(() => {
  memoryCore.resetMemoryDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const operations = await import("../../../../src/memory/operations.ts");

function wipeMemoryDb(): void {
  operations.deleteSetting("distillation.worker.global");
}

test("distillation worker settings resolve env, persist, and reset", () => {
  wipeMemoryDb();
  const initial = runtime.resolveDistillationWorkerRuntimeConfig({
    MEMORY_DISTILLATION_ENABLED: "true",
    MEMORY_DISTILLATION_INTERVAL: "120",
    MEMORY_DISTILLATION_CONCURRENCY: "4",
  });
  assert.deepEqual(initial, {
    enabled: true,
    intervalSeconds: 120,
    concurrency: 4,
    sourceLayer: "env",
  });

  const saved = runtime.saveDistillationWorkerRuntimeConfig({
    enabled: true,
    intervalSeconds: 300,
    concurrency: 2,
  });
  assert.equal(saved.sourceLayer, "stored");
  assert.equal(runtime.resolveDistillationWorkerRuntimeConfig().intervalSeconds, 300);

  const env = {
    MEMORY_DISTILLATION_ENABLED: "true",
    MEMORY_DISTILLATION_INTERVAL: "120",
    MEMORY_DISTILLATION_CONCURRENCY: "4",
  };
  const reset = runtime.deleteDistillationWorkerRuntimeConfig(env);
  assert.equal(reset.sourceLayer, "env");
  assert.equal(reset.intervalSeconds, 120);
  assert.equal(reset.concurrency, 4);
  assert.deepEqual(
    runtime.resolveDistillationWorkerRuntimeConfig({ MEMORY_DISTILLATION_ENABLED: undefined }),
    {
      enabled: false,
      intervalSeconds: 60,
      concurrency: 3,
      sourceLayer: "default",
    }
  );
});

test("invalid env numbers fall back to safe worker defaults", () => {
  wipeMemoryDb();
  const config = runtime.resolveDistillationWorkerRuntimeConfig({
    MEMORY_DISTILLATION_ENABLED: "true",
    MEMORY_DISTILLATION_INTERVAL: "nope",
    MEMORY_DISTILLATION_CONCURRENCY: "-2",
  });
  assert.deepEqual(config, {
    enabled: true,
    intervalSeconds: 60,
    concurrency: 3,
    sourceLayer: "env",
  });
});

test("stored worker settings gate L0-to-L1 enqueueing", async () => {
  const queue = await import("../../../../src/memory/integration/distillationQueue.ts");
  let calls = 0;
  const enqueuer = queue.createProductionL1TaskEnqueuer({
    env: {},
    enqueueTask() {
      calls++;
    },
  });

  runtime.saveDistillationWorkerRuntimeConfig({
    enabled: true,
    intervalSeconds: 60,
    concurrency: 1,
  });
  await enqueuer.enqueueL1Task({
    ownerId: "owner-1",
    sessionId: "session-1",
    correlationId: null,
    capturedAt: "2026-08-15T00:00:00.000Z",
    records: [],
  });
  assert.equal(calls, 0); // empty records never enqueue, but gate is resolved without throw
  operations.deleteSetting("distillation.worker.global");

  runtime.saveDistillationWorkerRuntimeConfig({
    enabled: false,
    intervalSeconds: 60,
    concurrency: 1,
  });
  await enqueuer.enqueueL1Task({
    ownerId: "owner-1",
    sessionId: "session-1",
    correlationId: null,
    capturedAt: "2026-08-15T00:00:00.000Z",
    records: [],
  });
  assert.equal(calls, 0);
  operations.deleteSetting("distillation.worker.global");
});

test("production startup merges stored worker settings into env", async () => {
  const runtimeModule = await import("../../../../src/memory/integration/distillationRuntime.ts");
  let received: NodeJS.ProcessEnv | null = null;
  runtime.saveDistillationWorkerRuntimeConfig({
    enabled: true,
    intervalSeconds: 300,
    concurrency: 2,
  });
  const started = await runtimeModule.startProductionDistillationWorker({
    env: {},
    allowAutomatedTestProcess: true,
    async startWorker(options) {
      received = options.env ?? {};
      return true;
    },
  });
  operations.deleteSetting("distillation.worker.global");
  assert.equal(started, true);
  assert.equal(received?.MEMORY_DISTILLATION_ENABLED, "true");
  assert.equal(received?.MEMORY_DISTILLATION_INTERVAL, "300");
  assert.equal(received?.MEMORY_DISTILLATION_CONCURRENCY, "2");
});
