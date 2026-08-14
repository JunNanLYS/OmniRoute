import test from "node:test";
import assert from "node:assert/strict";

import {
  getAuditWriter,
  getFourLayerService,
  getProviderModelValidator,
  getTaskEnqueuer,
  isNoOpService,
  resetAuditWriterForTesting,
  resetFourLayerServiceForTesting,
  resetProviderModelValidatorForTesting,
  resetTaskEnqueuerForTesting,
  setAuditWriterForTesting,
  setFourLayerServiceForTesting,
  setProviderModelValidatorForTesting,
  setTaskEnqueuerForTesting,
  type AuditWriter,
  type MemoryFourLayerService,
  type ProviderModelValidator,
  type TaskEnqueuer,
} from "../../src/memory/api/dependencies.ts";
import { createFourLayerService } from "../../src/memory/db/service.ts";

test.afterEach(() => {
  resetFourLayerServiceForTesting();
  resetProviderModelValidatorForTesting();
  resetAuditWriterForTesting();
  resetTaskEnqueuerForTesting();
});

test("default service is the standalone production adapter", () => {
  assert.equal(isNoOpService(), false);
  assert.ok(getFourLayerService());
});

test("test service overrides reset to the production adapter", async () => {
  const fakeService: MemoryFourLayerService = {
    ...createFourLayerService(),
    listL1: async () => ({ data: [], total: 0, page: 1, limit: 20 }),
  };

  setFourLayerServiceForTesting(fakeService);
  assert.equal(getFourLayerService(), fakeService);
  assert.equal(isNoOpService(), false);

  resetFourLayerServiceForTesting();
  assert.notEqual(getFourLayerService(), fakeService);
  assert.equal(isNoOpService(), false);
});

test("setProviderModelValidatorForTesting replaces the validator", async () => {
  let received: { provider: string; modelId: string } | null = null;
  const fake: ProviderModelValidator = async (input) => {
    received = input;
    return { ok: false, reason: "fake-reject" };
  };
  setProviderModelValidatorForTesting(fake);
  const out = await getProviderModelValidator()({ provider: "openai", modelId: "x" });
  assert.deepEqual(received, { provider: "openai", modelId: "x" });
  assert.deepEqual(out, { ok: false, reason: "fake-reject" });
});

test("setAuditWriterForTesting replaces the audit writer", async () => {
  let called = 0;
  const fake: AuditWriter = async () => {
    called++;
  };
  setAuditWriterForTesting(fake);
  await getAuditWriter()({
    action: "memory.l1.create",
    actor: { apiKeyId: "k", userId: null, actor: "apiKey", isManagement: false, apiKey: "" },
    target: "x",
    resourceType: "memory_l1",
  });
  assert.equal(called, 1);
});

test("setTaskEnqueuerForTesting replaces the task enqueuer", async () => {
  const fake: TaskEnqueuer = async () => ({ taskId: "fake-task-id" });
  setTaskEnqueuerForTesting(fake);
  const out = await getTaskEnqueuer()({
    layer: "l2",
    entryId: "abc",
    ownerApiKeyId: "k",
  });
  assert.deepEqual(out, { taskId: "fake-task-id" });
});
