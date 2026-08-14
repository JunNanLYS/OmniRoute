import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-four-layer-service-"));
process.env["DATA_DIR"] = TEST_DATA_DIR;
process.env["DISABLE_SQLITE_AUTO_BACKUP"] = "true";

const core = await import("../../src/memory/db/core.ts");
const { createFourLayerService } = await import("../../src/memory/db/service.ts");
const { ownerFromApiKeyId } = await import("../../src/memory/integration/runtime.ts");
const distillation = await import("../../src/memory/db/repositories/distillation.ts");

const service = createFourLayerService();

function scope(ownerApiKeyId: string, management = false) {
  return {
    actor: {
      apiKeyId: ownerApiKeyId,
      userId: null,
      actor: "apiKey" as const,
      isManagement: management,
      apiKey: "",
    },
    ownerApiKeyId,
    owner: ownerFromApiKeyId(ownerApiKeyId),
  };
}

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

test("L0 import/list/delete/restore is owner-scoped and idempotent", async () => {
  const ownerA = scope("owner-a");
  const imported = await service.importL0(ownerA, {
    sessionId: "session-1",
    items: [
      {
        idempotencyKey: "turn-1",
        role: "user",
        content: "Hello",
        timestamp: new Date("2026-01-01T00:00:00Z"),
      },
    ],
  });
  const duplicate = await service.importL0(ownerA, {
    sessionId: "session-1",
    items: [
      {
        idempotencyKey: "turn-1",
        role: "user",
        content: "Hello",
      },
    ],
  });
  assert.deepEqual(duplicate.importedIds, imported.importedIds);

  const listed = await service.listL0(ownerA, { page: 1, limit: 20 });
  assert.equal(listed.total, 1);
  assert.equal(listed.data[0]?.content, "Hello");
  assert.equal((await service.listL0(scope("owner-b"), {})).total, 0);

  assert.equal(await service.deleteL0(ownerA, imported.importedIds[0]!, "soft"), true);
  assert.equal((await service.listL0(ownerA, {})).total, 0);
  assert.equal((await service.listL0(ownerA, { includeDeleted: "deleted" })).total, 1);
  assert.equal((await service.restoreL0(ownerA, imported.importedIds[0]!))?.content, "Hello");
});

test("L1 uses the canonical taxonomy and atomic optimistic versions", async () => {
  const owner = scope("owner-a");
  const created = await service.createL1(owner, {
    type: "work_fact",
    priority: 80,
    content: "Uses TypeScript",
    sceneName: "project",
    metadata: { tags: ["typescript"] },
    sourceMessageIds: [],
  });
  assert.equal(created.type, "work_fact");
  assert.equal(created.version, 1);

  const first = await service.updateL1(owner, created.id, {
    content: "Uses strict TypeScript",
    expectedVersion: 1,
  });
  assert.equal(first.conflict, false);
  assert.equal(first.entry.version, 2);

  const stale = await service.updateL1(owner, created.id, {
    content: "stale write",
    expectedVersion: 1,
  });
  assert.equal(stale.conflict, true);
  assert.equal(stale.entry.content, "Uses strict TypeScript");

  assert.equal((await service.searchL1(owner, { q: "strict TypeScript" })).total, 1);
  await service.deleteL1(owner, created.id, "soft");
  assert.equal((await service.listL1(owner, { includeDeleted: "deleted" })).total, 1);
  assert.equal((await service.restoreL1(owner, created.id))?.version, 2);
});

test("L2 exposes native scene fields, version checks, and restore", async () => {
  const owner = scope("owner-a");
  const created = await service.createL2(owner, {
    sceneName: "project",
    groupKey: "repo-a",
    summary: "Project context",
    heat: 0.8,
    content: "Detailed project scene",
  });
  assert.equal(created.sceneName, "project");
  assert.equal(created.heat, 0.8);

  const updated = await service.updateL2(owner, created.id, {
    summary: "Updated context",
    heat: 0.9,
    expectedVersion: 1,
  });
  assert.equal(updated.conflict, false);
  assert.equal(updated.entry.version, 2);

  const stale = await service.updateL2(owner, created.id, {
    content: "stale",
    expectedVersion: 1,
  });
  assert.equal(stale.conflict, true);

  await service.deleteL2(owner, created.id, "soft");
  assert.equal((await service.listL2(owner, { includeDeleted: "deleted" })).total, 1);
  assert.equal((await service.restoreL2(owner, created.id))?.summary, "Updated context");
});

test("L3 is one versioned persona per owner", async () => {
  const owner = scope("owner-a");
  const first = await service.upsertL3(owner, {
    content: "Prefer concise answers",
    promptMode: "chat",
  });
  assert.equal(first.promptMode, "chat");
  assert.equal(first.version, 1);

  const second = await service.upsertL3(owner, {
    content: "Prefer concise code answers",
    promptMode: "code",
    expectedVersion: 1,
  });
  assert.equal(second.version, 2);
  assert.equal((await service.listL3(owner, {})).total, 1);
  assert.equal((await service.listL3(scope("owner-b"), {})).total, 0);

  await assert.rejects(
    () =>
      service.upsertL3(owner, {
        content: "stale",
        promptMode: "chat",
        expectedVersion: 1,
      }),
    /version conflict/i
  );

  await service.deleteL3(owner, second.id, "soft");
  assert.equal((await service.listL3(owner, { includeDeleted: "deleted" })).total, 1);
  assert.equal((await service.restoreL3(owner, second.id))?.version, 2);
});

test("L2 and L3 regeneration enqueue immediately executable owner-scoped payloads", async () => {
  const owner = scope("owner-regenerate");
  await service.createL1(owner, {
    type: "work_fact",
    priority: 80,
    content: "The project uses TypeScript",
    sceneName: "project",
    metadata: {},
    sourceMessageIds: ["l0-1"],
  });
  const scene = await service.createL2(owner, {
    sceneName: "project",
    groupKey: "repo-a",
    summary: "Project summary",
    heat: 0.8,
    content: "Detailed project context",
  });
  const persona = await service.upsertL3(owner, {
    content: "User-authored doctrine",
    promptMode: "code",
  });

  assert.deepEqual(await service.regenerateL2(owner, scene.id, { reason: "refresh" }), {
    enqueued: 1,
  });
  assert.deepEqual(await service.regenerateL3(owner, { reason: "refresh" }), {
    enqueued: 1,
  });

  const rows = core
    .getMemoryDbInstance()
    .prepare(
      `SELECT kind, payload_json, not_before FROM task_queue
       WHERE scope = ? ORDER BY kind ASC`
    )
    .all(owner.ownerApiKeyId) as Array<{
    kind: string;
    payload_json: string;
    not_before: number;
  }>;
  const l2Task = rows.find((row) => row.kind === "L2_scene");
  const l3Task = rows.find((row) => row.kind === "L3_persona");
  assert.ok(l2Task);
  assert.ok(l3Task);
  const l2Payload = JSON.parse(l2Task.payload_json) as Record<string, unknown>;
  assert.equal(l2Payload.sceneId, scene.id);
  assert.equal(l2Payload.sceneName, "project");
  assert.equal(l2Payload.groupKey, "repo-a");
  assert.match(String(l2Payload.conversation), /The project uses TypeScript/);
  assert.equal(l2Payload.allowUserOverwrite, true);
  assert.ok(l2Task.not_before <= Date.now());

  const l3Payload = JSON.parse(l3Task.payload_json) as {
    samples: string[];
    promptMode: string;
    baselineVersion: number;
    allowUserOverwrite: boolean;
  };
  assert.match(l3Payload.samples[0] ?? "", /Project summary/);
  assert.equal(l3Payload.promptMode, "code");
  assert.equal(l3Payload.baselineVersion, persona.version);
  assert.equal(l3Payload.allowUserOverwrite, true);
  assert.ok(l3Task.not_before <= Date.now());
});

test("distillation selector persists per-key/global overrides", async () => {
  const self = scope("owner-a");
  const management = scope("management", true);

  const perKey = await service.setDistillationSelector(self, {
    provider: "openai",
    modelId: "gpt-4o-mini",
    scope: "self",
    apiKeyId: "owner-a",
  });
  assert.equal(perKey.sourceLayer, "per-key");
  assert.equal((await service.getDistillationSelector(self)).modelId, "gpt-4o-mini");

  await service.setDistillationSelector(management, {
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
    scope: "global",
  });
  assert.equal((await service.getDistillationSelector(scope("owner-b"))).sourceLayer, "global");

  assert.equal(await service.deleteDistillationSelector(self, "self"), true);
  assert.equal((await service.getDistillationSelector(self)).sourceLayer, "global");
});

test("DLQ list/retry remains scoped to the caller owner", async () => {
  const owner = scope("owner-a");
  const task = distillation.enqueueDistillationTask({
    kind: "L2_scene",
    scope: "owner-a",
    payload: { conversation: "scene" },
    priority: 1,
    notBefore: 0,
    providerHint: null,
    modelHint: null,
  });
  const store = distillation.createDistillationStore();
  await store.markDLQ(task.id, "worker", "bad output", "parse_failed");
  await store.appendDLQ({
    taskId: task.id,
    reason: "parse_failed",
    failureKind: "parse_failed",
    attempts: 0,
    error: "bad output",
    recordedAt: 100,
  });

  const listed = await service.listDistillationDlq(owner, {
    limit: 20,
    statuses: ["pending"],
  });
  assert.equal(listed.entries.length, 1);
  assert.equal(
    (
      await service.listDistillationDlq(scope("owner-b"), {
        limit: 20,
        statuses: ["pending"],
      })
    ).entries.length,
    0
  );

  const retry = await service.retryDistillationDlq(owner, {
    ids: [listed.entries[0]!.id],
  });
  assert.deepEqual(retry, { retried: 1, skipped: 0 });
});

test("distillation usage listing remains scoped to the caller owner", async () => {
  const store = distillation.createDistillationStore();
  await store.recordUsage({
    taskId: "usage-owner-a-1",
    scope: "owner-a",
    kind: "L2_scene",
    provider: "openai",
    model: "gpt-4o-mini",
    tokens: 50,
    usd: 0.005,
    recordedAt: 100,
  });
  await store.recordUsage({
    taskId: "usage-owner-a-2",
    scope: "owner-a",
    kind: "L3_persona",
    provider: "openai",
    model: "gpt-4o-mini",
    tokens: 25,
    usd: 0.0025,
    recordedAt: 200,
  });
  await store.recordUsage({
    taskId: "usage-owner-b-1",
    scope: "owner-b",
    kind: "L2_scene",
    provider: "anthropic",
    model: "claude",
    tokens: 10,
    usd: 0.001,
    recordedAt: 300,
  });

  const ownerA = await service.listDistillationUsage(scope("owner-a"), { limit: 10 });
  assert.equal(ownerA.records.length, 2);
  assert.equal(ownerA.totals.tokens, 75);
  assert.equal(ownerA.totals.tasks, 2);

  const ownerB = await service.listDistillationUsage(scope("owner-b"), { limit: 10 });
  assert.equal(ownerB.records.length, 1);
  assert.equal(ownerB.totals.tokens, 10);
  assert.equal(ownerB.records[0]!.ownerApiKeyId, "owner-b");
});

test("getL0CaptureStatus returns the masked counters for the caller owner only", async () => {
  const telemetry = await import("../../src/memory/db/repositories/l0CaptureTelemetry.ts");
  telemetry.recordL0CaptureSuccess("owner-a");
  telemetry.recordL0CaptureFailure("owner-a", "storage_error");
  telemetry.recordL0CaptureSuccess("owner-b");

  const ownerA = await service.getL0CaptureStatus(scope("owner-a"));
  assert.equal(ownerA.ownerApiKeyId, "owner-a");
  assert.equal(ownerA.successCount, 1);
  assert.equal(ownerA.failureCount, 1);
  assert.equal(ownerA.lastFailureCategory, "storage_error");

  const ownerB = await service.getL0CaptureStatus(scope("owner-b"));
  assert.equal(ownerB.ownerApiKeyId, "owner-b");
  assert.equal(ownerB.successCount, 1);
  assert.equal(ownerB.failureCount, 0);
  assert.equal(ownerB.lastFailureCategory, null);
});
