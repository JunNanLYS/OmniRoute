import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-distillation-store-"));
process.env["DATA_DIR"] = TEST_DATA_DIR;
process.env["DISABLE_SQLITE_AUTO_BACKUP"] = "true";

const core = await import("../../../../src/memory/db/core.ts");
const storeModule = await import("../../../../src/memory/distillation/store.ts");
const repository = await import("../../../../src/memory/db/repositories/distillation.ts");

function wipeDb(): void {
  core.resetMemoryDbInstance();
  const filePath = core.getMemoryDbFilePath();
  if (filePath !== ":memory:") {
    for (const candidate of [
      filePath,
      `${filePath}-wal`,
      `${filePath}-shm`,
      `${filePath}-journal`,
    ]) {
      try {
        fs.unlinkSync(candidate);
      } catch {
        // File may not exist yet.
      }
    }
  }
}

test.afterEach(wipeDb);

test.after(() => {
  core.resetMemoryDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("enqueue is idempotent for the same captured L0 batch", () => {
  wipeDb();
  const input = {
    kind: "L1_extract" as const,
    scope: "api-key-idempotent",
    payload: {
      sourceMessageIds: ["l0-user", "l0-assistant"],
      conversation: "user: hello\nassistant: hi",
    },
    priority: 1,
    notBefore: 100,
    idempotencyKey: "l1:l0-user:l0-assistant",
  };

  const first = repository.enqueueDistillationTask(input);
  const second = repository.enqueueDistillationTask(input);
  const stats = repository.createDistillationStore().getQueueStats();

  assert.equal(first.id, second.id);
  return stats.then((value) => assert.equal(value.queued, 1));
});

test("queued downstream tasks coalesce by stable scope key", () => {
  wipeDb();
  const first = repository.enqueueDistillationTask({
    kind: "L2_scene",
    scope: "api-key-coalesce",
    payload: { conversation: "first" },
    priority: 2,
    notBefore: 20_000,
    coalesceKey: "l2:project-a",
  });
  const second = repository.enqueueDistillationTask({
    kind: "L2_scene",
    scope: "api-key-coalesce",
    payload: { conversation: "first\nsecond" },
    priority: 5,
    notBefore: 30_000,
    coalesceKey: "l2:project-a",
  });

  assert.equal(second.id, first.id);
  assert.equal(second.priority, 5);
  assert.equal(second.notBefore, 20_000);
  assert.deepEqual(second.payload, { conversation: "first\nsecond" });
});

test("queued idle tasks can replace their debounce deadline", () => {
  wipeDb();
  const first = repository.enqueueDistillationTask({
    kind: "L1_extract",
    scope: "api-key-debounce",
    payload: { conversation: "first" },
    notBefore: 20_000,
    coalesceKey: "l1:session-a",
    coalesceNotBefore: "replace",
  });
  const second = repository.enqueueDistillationTask({
    kind: "L1_extract",
    scope: "api-key-debounce",
    payload: { conversation: "first\nsecond" },
    notBefore: 30_000,
    coalesceKey: "l1:session-a",
    coalesceNotBefore: "replace",
  });

  assert.equal(second.id, first.id);
  assert.equal(second.notBefore, 30_000);
  assert.deepEqual(second.payload, { conversation: "first\nsecond" });
});

test("an active coalesced task suppresses duplicate queued work", async () => {
  wipeDb();
  const first = repository.enqueueDistillationTask({
    kind: "L1_extract",
    scope: "api-key-active",
    payload: { conversation: "first" },
    notBefore: 0,
    coalesceKey: "l1:session-a",
  });
  const store = repository.createDistillationStore({ applyResult: () => undefined });
  assert.equal(await store.markClaimed(first.id, first.version, "worker-a", 60_000), true);
  await store.markRunning(first.id, "worker-a");

  const duplicate = repository.enqueueDistillationTask({
    kind: "L1_extract",
    scope: "api-key-active",
    payload: { conversation: "first\nsecond" },
    notBefore: 1_000,
    coalesceKey: "l1:session-a",
  });

  assert.equal(duplicate.id, first.id);
  assert.deepEqual(duplicate.payload, { conversation: "first" });
  assert.deepEqual(await store.getQueueStats(), { queued: 0, running: 1, dlq: 0 });
});

test("task lease renewal prevents recovery by another worker", async () => {
  wipeDb();
  const queued = repository.enqueueDistillationTask({
    kind: "L2_scene",
    scope: "api-key-lease",
    payload: { conversation: "long task" },
    notBefore: 0,
  });
  const first = repository.createDistillationStore({ applyResult: () => undefined });
  const second = repository.createDistillationStore({ applyResult: () => undefined });
  assert.equal(await first.markClaimed(queued.id, queued.version, "worker-a", 1), true);
  await first.markRunning(queued.id, "worker-a");
  assert.equal(await first.renewTaskLease(queued.id, "worker-a", 60_000), true);
  assert.equal(await first.renewTaskLease(queued.id, "worker-b", 60_000), false);

  const claim = await second.claimNextTask(Date.now(), null);
  assert.equal(claim.task, null);
  assert.equal(repository.getDistillationTask(queued.id)?.status, "running");
});

test("completion persists usage in the same transaction as canonical results", async () => {
  wipeDb();
  const queued = repository.enqueueDistillationTask({
    kind: "L1_extract",
    scope: "api-key-usage-atomic",
    payload: { conversation: "usage" },
    notBefore: 0,
  });
  const store = repository.createDistillationStore({ applyResult: () => undefined });
  assert.equal(await store.markClaimed(queued.id, queued.version, "worker-a", 60_000), true);
  await store.markRunning(queued.id, "worker-a");
  await store.completeTask(
    queued,
    "worker-a",
    { payload: { scenes: [] }, fallbackEvidence: [] },
    {
      taskId: queued.id,
      scope: queued.scope,
      kind: queued.kind,
      provider: "openai",
      model: "gpt-4o-mini",
      tokens: 15,
      usd: 0.001,
      recordedAt: 100,
    }
  );

  assert.equal(repository.getDistillationTask(queued.id)?.status, "succeeded");
  const [usage] = repository.listDistillationUsageRecords({ scope: queued.scope });
  assert.equal(usage?.taskId, queued.id);
  assert.equal(usage?.tokens, 15);
  assert.equal(usage?.usd, 0.001);
});

test("late usage replay keeps the first record for a completed task", async () => {
  wipeDb();
  const queued = repository.enqueueDistillationTask({
    kind: "L1_extract",
    scope: "api-key-usage-replay",
    payload: { conversation: "usage replay" },
    notBefore: 0,
  });
  const store = repository.createDistillationStore({ applyResult: () => undefined });
  assert.equal(await store.markClaimed(queued.id, queued.version, "worker-a", 60_000), true);
  await store.markRunning(queued.id, "worker-a");
  const firstUsage = {
    taskId: queued.id,
    scope: queued.scope,
    kind: queued.kind,
    provider: "openai",
    model: "gpt-4o-mini",
    tokens: 15,
    usd: 0.001,
    recordedAt: 100,
  };

  await store.completeTask(
    queued,
    "worker-a",
    { payload: { memories: [] }, fallbackEvidence: [] },
    firstUsage
  );
  await store.recordUsage({
    ...firstUsage,
    provider: "anthropic",
    model: "claude-sonnet-5",
    tokens: 999,
    usd: 99,
    recordedAt: 200,
  });

  core.resetMemoryDbInstance();
  const usage = repository.listDistillationUsageRecords({ scope: queued.scope });
  assert.equal(usage.length, 1);
  assert.deepEqual(usage[0], firstUsage);
});

test("task completion succeeds when compatibility usage was recorded first", async () => {
  wipeDb();
  const db = core.getMemoryDbInstance();
  db.exec("CREATE TABLE usage_idempotency_probe (value TEXT NOT NULL)");
  const queued = repository.enqueueDistillationTask({
    kind: "L2_scene",
    scope: "api-key-usage-before-completion",
    payload: { conversation: "usage before completion" },
    notBefore: 0,
  });
  const store = repository.createDistillationStore({
    applyResult() {
      db.prepare("INSERT INTO usage_idempotency_probe (value) VALUES (?)").run("applied");
    },
  });
  assert.equal(await store.markClaimed(queued.id, queued.version, "worker-a", 60_000), true);
  await store.markRunning(queued.id, "worker-a");
  const firstUsage = {
    taskId: queued.id,
    scope: queued.scope,
    kind: queued.kind,
    provider: "openai",
    model: "gpt-4o-mini",
    tokens: 10,
    usd: 0.01,
    recordedAt: 100,
  };
  await store.recordUsage(firstUsage);

  await store.completeTask(
    queued,
    "worker-a",
    { payload: { scene: "focused work" }, fallbackEvidence: [] },
    { ...firstUsage, tokens: 20, usd: 0.02, recordedAt: 200 }
  );

  assert.equal(repository.getDistillationTask(queued.id)?.status, "succeeded");
  const probe = db.prepare("SELECT COUNT(*) AS count FROM usage_idempotency_probe").get() as {
    count: number;
  };
  assert.equal(probe.count, 1);
  const usage = repository.listDistillationUsageRecords({ scope: queued.scope });
  assert.equal(usage.length, 1);
  assert.deepEqual(usage[0], firstUsage);
});

test("usage insert failure rolls back task success and canonical writes", async () => {
  wipeDb();
  const db = core.getMemoryDbInstance();
  db.exec("CREATE TABLE usage_apply_probe (value TEXT NOT NULL)");
  const queued = repository.enqueueDistillationTask({
    kind: "L1_extract",
    scope: "api-key-usage-rollback",
    payload: { conversation: "usage failure" },
    notBefore: 0,
  });
  const store = repository.createDistillationStore({
    applyResult() {
      db.prepare("INSERT INTO usage_apply_probe (value) VALUES (?)").run("partial");
    },
  });
  assert.equal(await store.markClaimed(queued.id, queued.version, "worker-a", 60_000), true);
  await store.markRunning(queued.id, "worker-a");
  db.exec(`
    CREATE TRIGGER fail_distillation_usage_insert
    BEFORE INSERT ON distillation_usage
    BEGIN
      SELECT RAISE(ABORT, 'forced usage insert failure');
    END;
  `);

  await assert.rejects(
    store.completeTask(
      queued,
      "worker-a",
      { payload: { scenes: [] }, fallbackEvidence: [] },
      {
        taskId: queued.id,
        scope: queued.scope,
        kind: queued.kind,
        provider: "openai",
        model: "gpt-4o-mini",
        tokens: 15,
        usd: 0.001,
        recordedAt: 100,
      }
    ),
    /forced usage insert failure/
  );

  assert.equal(repository.getDistillationTask(queued.id)?.status, "running");
  const row = db.prepare("SELECT COUNT(*) AS count FROM usage_apply_probe").get() as {
    count: number;
  };
  assert.equal(row.count, 0);
  assert.equal(repository.listDistillationUsageRecords({ scope: queued.scope }).length, 0);
});

test("usage idempotency migration deduplicates historical task rows", () => {
  wipeDb();
  let db = core.getMemoryDbInstance();
  db.exec("DROP INDEX idx_distillation_usage_task");
  db.prepare("DELETE FROM _memory_migrations WHERE version = ?").run("009");
  const insert = db.prepare(
    `INSERT INTO distillation_usage (
      task_id, scope, kind, provider, model, tokens, usd, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insert.run("historical-task", "owner", "L1_extract", "first", "model-a", 10, 0.01, 100);
  insert.run("historical-task", "owner", "L1_extract", "second", "model-b", 20, 0.02, 200);

  core.resetMemoryDbInstance();
  db = core.getMemoryDbInstance();
  const rows = db
    .prepare(
      `SELECT provider, model, tokens, usd, recorded_at
       FROM distillation_usage WHERE task_id = ? ORDER BY usage_id`
    )
    .all("historical-task") as Array<{
    provider: string;
    model: string;
    tokens: number;
    usd: number;
    recorded_at: number;
  }>;
  const index = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get("idx_distillation_usage_task") as { name?: string } | undefined;

  assert.deepEqual(rows, [
    { provider: "first", model: "model-a", tokens: 10, usd: 0.01, recorded_at: 100 },
  ]);
  assert.equal(index?.name, "idx_distillation_usage_task");
});

test("successful handler payload and fallback evidence persist with the task", async () => {
  wipeDb();
  const queued = repository.enqueueDistillationTask({
    kind: "L1_extract",
    scope: "api-key-result",
    payload: { conversation: "I prefer TypeScript" },
    priority: 5,
    notBefore: 0,
    providerHint: null,
    modelHint: null,
  });
  const store = repository.createDistillationStore({ applyResult: () => undefined });
  assert.equal(await store.markClaimed(queued.id, 1, "worker-a", 60_000), true);
  await store.markRunning(queued.id, "worker-a");
  await store.completeTask(queued, "worker-a", {
    payload: { facts: [{ content: "Prefers TypeScript" }] },
    fallbackEvidence: [{ kind: "preference", match: "TypeScript" }],
  });

  core.resetMemoryDbInstance();
  const result = repository.getDistillationTaskResult(queued.id);
  assert.deepEqual(result?.payload, { facts: [{ content: "Prefers TypeScript" }] });
  assert.deepEqual(result?.fallbackEvidence, [{ kind: "preference", match: "TypeScript" }]);
});

test("completion atomically rolls back applied writes when result application fails", async () => {
  wipeDb();
  const db = core.getMemoryDbInstance();
  db.exec("CREATE TABLE apply_probe (value TEXT NOT NULL)");
  const queued = repository.enqueueDistillationTask({
    kind: "L1_extract",
    scope: "api-key-atomic",
    payload: { conversation: "atomic" },
    notBefore: 0,
  });
  const store = repository.createDistillationStore({
    applyResult() {
      db.prepare("INSERT INTO apply_probe (value) VALUES (?)").run("partial");
      throw new Error("canonical apply failed");
    },
  });
  assert.equal(await store.markClaimed(queued.id, queued.version, "worker-a", 60_000), true);
  await store.markRunning(queued.id, "worker-a");

  await assert.rejects(
    store.completeTask(queued, "worker-a", {
      payload: { facts: [] },
      fallbackEvidence: [],
    }),
    /canonical apply failed/
  );

  assert.equal(repository.getDistillationTask(queued.id)?.status, "running");
  const row = db.prepare("SELECT COUNT(*) AS count FROM apply_probe").get() as { count: number };
  assert.equal(row.count, 0);
});

test("completion validates claim ownership before applying canonical writes", async () => {
  wipeDb();
  const queued = repository.enqueueDistillationTask({
    kind: "L2_scene",
    scope: "api-key-owned",
    payload: { conversation: "owned" },
    notBefore: 0,
  });
  let applyCalls = 0;
  const store = repository.createDistillationStore({
    applyResult() {
      applyCalls++;
    },
  });
  assert.equal(await store.markClaimed(queued.id, queued.version, "worker-a", 60_000), true);
  await store.markRunning(queued.id, "worker-a");

  await assert.rejects(
    store.completeTask(queued, "worker-b", {
      payload: { summary: "wrong owner" },
      fallbackEvidence: [],
    }),
    /claim ownership/i
  );

  assert.equal(applyCalls, 0);
  assert.equal(repository.getDistillationTask(queued.id)?.status, "running");
});

test("DLQ transition and entry insertion commit atomically", async () => {
  wipeDb();
  const queued = repository.enqueueDistillationTask({
    kind: "L2_scene",
    scope: "api-key-dlq-atomic",
    payload: { conversation: "bad result" },
    notBefore: 0,
  });
  const store = repository.createDistillationStore({ applyResult: () => undefined });
  assert.equal(await store.markClaimed(queued.id, queued.version, "worker-a", 60_000), true);
  await store.markRunning(queued.id, "worker-a");

  await store.moveToDLQ(queued.id, "worker-a", {
    taskId: queued.id,
    reason: "semantic_invalid",
    failureKind: "semantic_invalid",
    attempts: 0,
    error: "invalid scene",
    recordedAt: 100,
  });

  assert.equal(repository.getDistillationTask(queued.id)?.status, "failed_dlq");
  const [entry] = repository.listDistillationDlqEntries({ scope: "api-key-dlq-atomic" });
  assert.equal(entry?.taskId, queued.id);
  assert.equal(entry?.failureKind, "semantic_invalid");
});

test("DLQ insert failure rolls back the task status transition", async () => {
  wipeDb();
  const queued = repository.enqueueDistillationTask({
    kind: "L3_persona",
    scope: "api-key-dlq-rollback",
    payload: { samples: ["bad"] },
    notBefore: 0,
  });
  const store = repository.createDistillationStore({ applyResult: () => undefined });
  assert.equal(await store.markClaimed(queued.id, queued.version, "worker-a", 60_000), true);
  await store.markRunning(queued.id, "worker-a");
  core.getMemoryDbInstance().exec(`
    CREATE TRIGGER fail_dlq_insert
    BEFORE INSERT ON task_dlq
    BEGIN
      SELECT RAISE(ABORT, 'forced dlq insert failure');
    END;
  `);

  await assert.rejects(
    store.moveToDLQ(queued.id, "worker-a", {
      taskId: queued.id,
      reason: "parse_failed",
      failureKind: "parse_failed",
      attempts: 0,
      error: "bad JSON",
      recordedAt: 100,
    }),
    /forced dlq insert failure/
  );

  assert.equal(repository.getDistillationTask(queued.id)?.status, "running");
  assert.equal(repository.listDistillationDlqEntries({ scope: "api-key-dlq-rollback" }).length, 0);
});

test("DLQ retry requeues only selected pending entries", async () => {
  wipeDb();
  const queued = repository.enqueueDistillationTask({
    kind: "L2_scene",
    scope: "api-key-retry",
    payload: { conversation: "scene" },
    priority: 3,
    notBefore: 0,
    providerHint: null,
    modelHint: null,
  });
  const store = repository.createDistillationStore();
  await store.markDLQ(queued.id, "worker-a", "bad output", "parse_failed");
  await store.appendDLQ({
    taskId: queued.id,
    reason: "parse_failed",
    failureKind: "parse_failed",
    attempts: 0,
    error: "bad output",
    recordedAt: 100,
  });
  const [entry] = repository.listDistillationDlqEntries({ scope: "api-key-retry" });
  assert.ok(entry);

  const outcome = repository.retryDistillationDlqEntries([entry.id]);
  assert.deepEqual(outcome, { retried: 1, skipped: 0 });
  assert.equal(repository.getDistillationTask(queued.id)?.status, "queued");
  assert.equal(repository.getDistillationTask(queued.id)?.attempt, 0);
  assert.equal(
    repository.listDistillationDlqEntries({ scope: "api-key-retry" })[0]?.status,
    "succeeded"
  );

  assert.deepEqual(repository.retryDistillationDlqEntries([entry.id]), {
    retried: 0,
    skipped: 1,
  });
});

test("default distillation store uses the persistent memory.db repository", async () => {
  wipeDb();
  const store = await storeModule.createDefaultDistillationStore();
  const queued = repository.enqueueDistillationTask({
    kind: "L1_extract",
    scope: "api-key-default",
    payload: { conversation: "persisted by default" },
    priority: 1,
    notBefore: 0,
    providerHint: null,
    modelHint: null,
  });
  core.resetMemoryDbInstance();
  const claim = await store.claimNextTask(Date.now(), null);
  assert.equal(claim.task?.id, queued.id);
});

test("queued distillation tasks survive a memory.db restart", async () => {
  wipeDb();
  const queued = repository.enqueueDistillationTask({
    kind: "L1_extract",
    scope: "api-key-1",
    payload: { conversation: "hello" },
    priority: 7,
    notBefore: 100,
    providerHint: null,
    modelHint: null,
  });

  core.resetMemoryDbInstance();
  const store = repository.createDistillationStore();
  const claim = await store.claimNextTask(101, null);

  assert.equal(claim.task?.id, queued.id);
  assert.equal(claim.task?.kind, "L1_extract");
  assert.deepEqual(claim.task?.payload, { conversation: "hello" });
  assert.equal(claim.task?.priority, 7);
  assert.equal(claim.task?.version, 1);
});

test("optimistic claim is atomic across two store instances", async () => {
  wipeDb();
  const queued = repository.enqueueDistillationTask({
    kind: "L2_scene",
    scope: "api-key-1",
    payload: { conversation: "scene" },
    priority: 5,
    notBefore: 0,
    providerHint: null,
    modelHint: null,
  });
  const first = repository.createDistillationStore();
  const second = repository.createDistillationStore();

  const [a, b] = await Promise.all([
    first.markClaimed(queued.id, 1, "worker-a", 60_000),
    second.markClaimed(queued.id, 1, "worker-b", 60_000),
  ]);

  assert.equal(Number(a) + Number(b), 1);
  const persisted = repository.getDistillationTask(queued.id);
  assert.equal(persisted?.status, "claimed");
  assert.equal(persisted?.version, 2);
});

test("retry, DLQ, and usage records persist across restart", async () => {
  wipeDb();
  const queued = repository.enqueueDistillationTask({
    kind: "L3_persona",
    scope: "api-key-2",
    payload: { samples: ["one"] },
    priority: 9,
    notBefore: 0,
    providerHint: "openai",
    modelHint: "gpt-4o-mini",
  });
  const store = repository.createDistillationStore();
  assert.equal(await store.markClaimed(queued.id, 1, "worker-a", 60_000), true);
  await store.markRunning(queued.id, "worker-a");
  await store.markRetry(queued.id, "worker-a", 1, 5_000, "rate limited");

  let persisted = repository.getDistillationTask(queued.id);
  assert.equal(persisted?.status, "queued");
  assert.equal(persisted?.attempt, 1);
  assert.equal(persisted?.version, 4);

  assert.equal(await store.markClaimed(queued.id, 4, "worker-a", 60_000), true);
  await store.markDLQ(queued.id, "worker-a", "model deleted", "model_deleted");
  await store.appendDLQ({
    taskId: queued.id,
    reason: "model_deleted",
    failureKind: "model_deleted",
    attempts: 1,
    error: "model deleted",
    recordedAt: 10_000,
  });
  await store.recordUsage({
    taskId: queued.id,
    scope: "api-key-2",
    kind: "L3_persona",
    provider: "openai",
    model: "gpt-4o-mini",
    tokens: 42,
    usd: 0.01,
    recordedAt: 11_000,
  });

  core.resetMemoryDbInstance();
  persisted = repository.getDistillationTask(queued.id);
  const dlq = repository.listDistillationDlqEntries({ scope: "api-key-2" });
  const usage = repository.listDistillationUsageRecords({ scope: "api-key-2" });

  assert.equal(persisted?.status, "failed_dlq");
  assert.equal(persisted?.version, 6);
  assert.equal(dlq.length, 1);
  assert.equal(dlq[0]?.failureKind, "model_deleted");
  assert.equal(usage.length, 1);
  assert.equal(usage[0]?.tokens, 42);
  assert.equal(usage[0]?.usd, 0.01);
});

test("scope locks are mutually exclusive across store instances", async () => {
  wipeDb();
  const first = repository.createDistillationStore();
  const second = repository.createDistillationStore();

  const held = await first.acquireLock("api-key-1", "worker-a", 60_000);
  const denied = await second.acquireLock("api-key-1", "worker-b", 60_000);
  assert.equal(held?.ownerId, "worker-a");
  assert.equal(denied, null);

  await first.releaseLock("api-key-1", "worker-a");
  const acquired = await second.acquireLock("api-key-1", "worker-b", 60_000);
  assert.equal(acquired?.ownerId, "worker-b");
});
