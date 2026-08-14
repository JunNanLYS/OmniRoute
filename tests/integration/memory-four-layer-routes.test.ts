import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-four-layer-routes-"));
process.env["DATA_DIR"] = TEST_DATA_DIR;
process.env["API_KEY_SECRET"] = "test-secret-four-layer";
process.env["JWT_SECRET"] = "test-jwt-secret-four-layer";
process.env["DISABLE_SQLITE_AUTO_BACKUP"] = "true";

const dbCore = await import("../../src/lib/db/core.ts");
const memoryCore = await import("../../src/memory/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const dependencies = await import("../../src/memory/api/dependencies.ts");
const distillation = await import("../../src/memory/db/repositories/distillation.ts");
const { createFourLayerService } = await import("../../src/memory/db/service.ts");

await settingsDb.updateSettings({ requireLogin: false });
const selfRecord = await apiKeysDb.createApiKey("memory-self", "1111111111111111", []);
const managementRecord = await apiKeysDb.createApiKey("memory-management", "2222222222222222", [
  "manage",
]);

const selfHeaders = (): Headers =>
  new Headers({
    authorization: `Bearer ${selfRecord.key}`,
    "content-type": "application/json",
  });
const managementHeaders = (): Headers =>
  new Headers({
    authorization: `Bearer ${managementRecord.key}`,
    "content-type": "application/json",
  });

function wipeMemoryDb(): void {
  memoryCore.resetMemoryDbInstance();
  const filePath = memoryCore.getMemoryDbFilePath();
  if (filePath === ":memory:") return;
  for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`, `${filePath}-journal`]) {
    try {
      fs.unlinkSync(candidate);
    } catch {
      // File may not exist yet.
    }
  }
}

function configureProductionDependencies(): void {
  dependencies.resetFourLayerServiceForTesting();
  dependencies.setAuditWriterForTesting(async () => undefined);
  dependencies.setProviderModelValidatorForTesting(async () => ({ ok: true }));
}

test.beforeEach(() => {
  wipeMemoryDb();
  configureProductionDependencies();
});

test.after(() => {
  dependencies.resetFourLayerServiceForTesting();
  dependencies.resetAuditWriterForTesting();
  dependencies.resetProviderModelValidatorForTesting();
  memoryCore.resetMemoryDbInstance();
  dbCore.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("invalid bearer credentials are rejected", async () => {
  const route = await import("../../src/app/api/memory/l0/route.ts");
  const response = await route.GET(
    new Request("http://localhost/api/memory/l0", {
      headers: { authorization: "Bearer invalid-memory-key" },
    })
  );
  assert.equal(response.status, 401);
});

test("owner scope rejects self overrides and honors management overrides", async () => {
  const route = await import("../../src/app/api/memory/l1/route.ts");
  const denied = await route.GET(
    new Request("http://localhost/api/memory/l1?apiKeyId=other-owner", {
      headers: selfHeaders(),
    })
  );
  assert.equal(denied.status, 403);

  const allowed = await route.GET(
    new Request(`http://localhost/api/memory/l1?apiKeyId=${selfRecord.id}`, {
      headers: managementHeaders(),
    })
  );
  assert.equal(allowed.status, 200);
});

test("collection routes pass only layer-supported filters to storage", async () => {
  const captured: Record<string, Record<string, unknown>> = {};
  const emptyResult = { data: [], total: 0, page: 1, limit: 20 };
  dependencies.setFourLayerServiceForTesting({
    ...createFourLayerService(),
    listL0: async (_scope, query) => {
      captured.l0 = query;
      return emptyResult;
    },
    listL1: async (_scope, query) => {
      captured.l1 = query;
      return emptyResult;
    },
    searchL1: async (_scope, query) => {
      captured.l1 = query;
      return emptyResult;
    },
    listL2: async (_scope, query) => {
      captured.l2 = query;
      return emptyResult;
    },
    listL3: async (_scope, query) => {
      captured.l3 = query;
      return emptyResult;
    },
  });

  const routes = {
    l0: await import("../../src/app/api/memory/l0/route.ts"),
    l1: await import("../../src/app/api/memory/l1/route.ts"),
    l2: await import("../../src/app/api/memory/l2/route.ts"),
    l3: await import("../../src/app/api/memory/l3/route.ts"),
  };
  const query = new URLSearchParams({
    page: "1",
    limit: "20",
    offset: "0",
    sessionId: "session-a",
    sceneName: "scene-a",
    sourceId: "source-a",
    type: "work_fact",
    q: "needle",
    includeDeleted: "any",
  });

  for (const [layer, route] of Object.entries(routes)) {
    const response = await route.GET(
      new Request(`http://localhost/api/memory/${layer}?${query}`, { headers: selfHeaders() })
    );
    assert.equal(response.status, 200);
  }

  assert.deepEqual(
    Object.keys(captured.l0).sort(),
    ["apiKeyId", "includeDeleted", "limit", "offset", "page", "q", "sessionId"].sort()
  );
  assert.deepEqual(
    Object.keys(captured.l1).sort(),
    ["apiKeyId", "includeDeleted", "limit", "offset", "page", "q", "sceneName", "type"].sort()
  );
  assert.deepEqual(
    Object.keys(captured.l2).sort(),
    ["apiKeyId", "includeDeleted", "limit", "offset", "page", "q", "sceneName"].sort()
  );
  assert.deepEqual(
    Object.keys(captured.l3).sort(),
    ["apiKeyId", "includeDeleted", "limit", "offset", "page"].sort()
  );
});

test("L0 canonical import is idempotent and supports session recycle", async () => {
  const collection = await import("../../src/app/api/memory/l0/route.ts");
  const detail = await import("../../src/app/api/memory/l0/[id]/route.ts");
  const importBody = {
    sessionId: "session-1",
    items: [
      {
        idempotencyKey: "turn-1",
        role: "user",
        content: "hello memory",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ],
  };

  const first = await collection.POST(
    new Request("http://localhost/api/memory/l0", {
      method: "POST",
      headers: selfHeaders(),
      body: JSON.stringify(importBody),
    })
  );
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  const id = firstBody.importedIds[0] as string;

  const duplicate = await collection.POST(
    new Request("http://localhost/api/memory/l0", {
      method: "POST",
      headers: selfHeaders(),
      body: JSON.stringify(importBody),
    })
  );
  assert.equal(duplicate.status, 201);
  assert.deepEqual((await duplicate.json()).importedIds, [id]);

  const listed = await collection.GET(
    new Request("http://localhost/api/memory/l0?sessionId=session-1", {
      headers: selfHeaders(),
    })
  );
  const listedBody = await listed.json();
  assert.equal(listedBody.data.length, 1);
  assert.equal(listedBody.data[0].content, "hello memory");

  const deleted = await collection.POST(
    new Request("http://localhost/api/memory/l0?sessionId=session-1", {
      method: "POST",
      headers: selfHeaders(),
      body: JSON.stringify({ sessionId: "session-1", mode: "soft" }),
    })
  );
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).deleted, 1);

  const recycle = await collection.GET(
    new Request("http://localhost/api/memory/l0?includeDeleted=deleted", {
      headers: selfHeaders(),
    })
  );
  assert.equal((await recycle.json()).data.length, 1);

  const restored = await detail.POST(
    new Request(`http://localhost/api/memory/l0/${id}?op=restore`, {
      method: "POST",
      headers: selfHeaders(),
    }),
    { params: Promise.resolve({ id }) }
  );
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).data.content, "hello memory");
});

test("L1 canonical taxonomy supports optimistic conflict and recycle restore", async () => {
  const collection = await import("../../src/app/api/memory/l1/route.ts");
  const detail = await import("../../src/app/api/memory/l1/[id]/route.ts");
  const createdResponse = await collection.POST(
    new Request("http://localhost/api/memory/l1", {
      method: "POST",
      headers: selfHeaders(),
      body: JSON.stringify({
        type: "work_fact",
        priority: 80,
        content: "Uses TypeScript",
        sceneName: "project",
        metadata: { tags: ["typescript"] },
        sourceMessageIds: [],
      }),
    })
  );
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).data;
  assert.equal(created.type, "work_fact");
  assert.equal(created.version, 1);

  const updated = await detail.PUT(
    new Request(`http://localhost/api/memory/l1/${created.id}`, {
      method: "PUT",
      headers: selfHeaders(),
      body: JSON.stringify({ content: "Uses strict TypeScript", expectedVersion: 1 }),
    }),
    { params: Promise.resolve({ id: created.id as string }) }
  );
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).data.version, 2);

  const stale = await detail.PUT(
    new Request(`http://localhost/api/memory/l1/${created.id}`, {
      method: "PUT",
      headers: selfHeaders(),
      body: JSON.stringify({ content: "stale", expectedVersion: 1 }),
    }),
    { params: Promise.resolve({ id: created.id as string }) }
  );
  assert.equal(stale.status, 409);

  const deleted = await detail.DELETE(
    new Request(`http://localhost/api/memory/l1/${created.id}`, {
      method: "DELETE",
      headers: selfHeaders(),
      body: JSON.stringify({ mode: "soft" }),
    }),
    { params: Promise.resolve({ id: created.id as string }) }
  );
  assert.equal(deleted.status, 200);

  const recycle = await collection.GET(
    new Request("http://localhost/api/memory/l1?includeDeleted=deleted", {
      headers: selfHeaders(),
    })
  );
  assert.equal((await recycle.json()).data.length, 1);

  const restored = await detail.POST(
    new Request(`http://localhost/api/memory/l1/${created.id}?op=restore`, {
      method: "POST",
      headers: selfHeaders(),
    }),
    { params: Promise.resolve({ id: created.id as string }) }
  );
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).data.version, 2);
});

test("L2 canonical scenes support optimistic conflict and regeneration enqueue", async () => {
  const collection = await import("../../src/app/api/memory/l2/route.ts");
  const detail = await import("../../src/app/api/memory/l2/[id]/route.ts");
  const regenerate = await import("../../src/app/api/memory/l2/[id]/regenerate/route.ts");
  const createdResponse = await collection.POST(
    new Request("http://localhost/api/memory/l2", {
      method: "POST",
      headers: selfHeaders(),
      body: JSON.stringify({
        sceneName: "project",
        groupKey: "repo-a",
        summary: "Project context",
        heat: 0.8,
        content: "Detailed project scene",
      }),
    })
  );
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).data;

  const updated = await detail.PUT(
    new Request(`http://localhost/api/memory/l2/${created.id}`, {
      method: "PUT",
      headers: selfHeaders(),
      body: JSON.stringify({ summary: "Updated context", heat: 0.9, expectedVersion: 1 }),
    }),
    { params: Promise.resolve({ id: created.id as string }) }
  );
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).data.version, 2);

  const stale = await detail.PUT(
    new Request(`http://localhost/api/memory/l2/${created.id}`, {
      method: "PUT",
      headers: selfHeaders(),
      body: JSON.stringify({ content: "stale", expectedVersion: 1 }),
    }),
    { params: Promise.resolve({ id: created.id as string }) }
  );
  assert.equal(stale.status, 409);

  const regenerated = await regenerate.POST(
    new Request(`http://localhost/api/memory/l2/${created.id}/regenerate`, {
      method: "POST",
      headers: selfHeaders(),
      body: JSON.stringify({ reason: "refresh" }),
    }),
    { params: Promise.resolve({ id: created.id as string }) }
  );
  assert.equal(regenerated.status, 200);
  assert.equal((await regenerated.json()).enqueued, 1);
  assert.equal((await distillation.createDistillationStore().getQueueStats()).queued, 1);
});

test("bodyless L2 and L3 regeneration use the empty default body", async () => {
  const l2Collection = await import("../../src/app/api/memory/l2/route.ts");
  const l2Regenerate = await import("../../src/app/api/memory/l2/[id]/regenerate/route.ts");
  const l3Collection = await import("../../src/app/api/memory/l3/route.ts");
  const sceneResponse = await l2Collection.POST(
    new Request("http://localhost/api/memory/l2", {
      method: "POST",
      headers: selfHeaders(),
      body: JSON.stringify({
        sceneName: "bodyless",
        summary: "Bodyless regeneration",
        heat: 0.5,
        content: "Scene source",
      }),
    })
  );
  const scene = (await sceneResponse.json()).data;

  const l2Response = await l2Regenerate.POST(
    new Request(`http://localhost/api/memory/l2/${scene.id}/regenerate`, {
      method: "POST",
      headers: selfHeaders(),
    }),
    { params: Promise.resolve({ id: scene.id as string }) }
  );
  assert.equal(l2Response.status, 200);
  assert.equal((await l2Response.json()).enqueued, 1);

  const l3Response = await l3Collection.POST(
    new Request("http://localhost/api/memory/l3", {
      method: "POST",
      headers: selfHeaders(),
    })
  );
  assert.equal(l3Response.status, 200);
  assert.equal((await l3Response.json()).enqueued, 1);
});

test("L3 singleton persona returns 409 for stale expectedVersion and restores", async () => {
  const collection = await import("../../src/app/api/memory/l3/route.ts");
  const detail = await import("../../src/app/api/memory/l3/[id]/route.ts");
  const firstResponse = await detail.PUT(
    new Request("http://localhost/api/memory/l3/persona", {
      method: "PUT",
      headers: selfHeaders(),
      body: JSON.stringify({ content: "Prefer concise answers", promptMode: "chat" }),
    }),
    { params: Promise.resolve({ id: "persona" }) }
  );
  assert.equal(firstResponse.status, 200);
  const first = (await firstResponse.json()).data;

  const secondResponse = await detail.PUT(
    new Request(`http://localhost/api/memory/l3/${first.id}`, {
      method: "PUT",
      headers: selfHeaders(),
      body: JSON.stringify({
        content: "Prefer concise code answers",
        promptMode: "code",
        expectedVersion: 1,
      }),
    }),
    { params: Promise.resolve({ id: first.id as string }) }
  );
  assert.equal(secondResponse.status, 200);
  assert.equal((await secondResponse.json()).data.version, 2);

  const stale = await detail.PUT(
    new Request(`http://localhost/api/memory/l3/${first.id}`, {
      method: "PUT",
      headers: selfHeaders(),
      body: JSON.stringify({ content: "stale", promptMode: "chat", expectedVersion: 1 }),
    }),
    { params: Promise.resolve({ id: first.id as string }) }
  );
  assert.equal(stale.status, 409);

  const listed = await collection.GET(
    new Request("http://localhost/api/memory/l3", { headers: selfHeaders() })
  );
  assert.equal((await listed.json()).data.length, 1);

  const deleted = await detail.DELETE(
    new Request(`http://localhost/api/memory/l3/${first.id}`, {
      method: "DELETE",
      headers: selfHeaders(),
      body: JSON.stringify({ mode: "soft" }),
    }),
    { params: Promise.resolve({ id: first.id as string }) }
  );
  assert.equal(deleted.status, 200);

  const restored = await detail.DELETE(
    new Request(`http://localhost/api/memory/l3/${first.id}`, {
      method: "DELETE",
      headers: selfHeaders(),
      body: JSON.stringify({ mode: "restore" }),
    }),
    { params: Promise.resolve({ id: first.id as string }) }
  );
  assert.equal(restored.status, 200);
});

test("distillation selector persists self and global tiers", async () => {
  const route = await import("../../src/app/api/memory/distillation-model/route.ts");
  const initial = await route.GET(
    new Request("http://localhost/api/memory/distillation-model", { headers: selfHeaders() })
  );
  assert.equal((await initial.json()).data.sourceLayer, "auto");

  const selfSet = await route.PUT(
    new Request("http://localhost/api/memory/distillation-model", {
      method: "PUT",
      headers: selfHeaders(),
      body: JSON.stringify({ provider: "openai", modelId: "gpt-4o-mini", scope: "self" }),
    })
  );
  assert.equal(selfSet.status, 200);
  assert.equal((await selfSet.json()).data.apiKeyId, selfRecord.id);

  const globalDenied = await route.PUT(
    new Request("http://localhost/api/memory/distillation-model", {
      method: "PUT",
      headers: selfHeaders(),
      body: JSON.stringify({ provider: "anthropic", modelId: "claude", scope: "global" }),
    })
  );
  assert.equal(globalDenied.status, 403);

  const globalSet = await route.PUT(
    new Request("http://localhost/api/memory/distillation-model", {
      method: "PUT",
      headers: managementHeaders(),
      body: JSON.stringify({ provider: "anthropic", modelId: "claude", scope: "global" }),
    })
  );
  assert.equal(globalSet.status, 200);

  const managementEffective = await route.GET(
    new Request("http://localhost/api/memory/distillation-model", {
      headers: managementHeaders(),
    })
  );
  assert.equal((await managementEffective.json()).data.sourceLayer, "global");

  const selfDelete = await route.DELETE(
    new Request("http://localhost/api/memory/distillation-model?scope=self", {
      method: "DELETE",
      headers: selfHeaders(),
    })
  );
  assert.equal(selfDelete.status, 200);

  const fallback = await route.GET(
    new Request("http://localhost/api/memory/distillation-model", { headers: selfHeaders() })
  );
  assert.equal((await fallback.json()).data.sourceLayer, "global");
});

test("DLQ listing and retry are owner-scoped", async () => {
  const ownTask = distillation.enqueueDistillationTask({
    kind: "L2_scene",
    scope: selfRecord.id,
    payload: { sceneId: "own" },
  });
  const otherTask = distillation.enqueueDistillationTask({
    kind: "L2_scene",
    scope: "other-owner",
    payload: { sceneId: "other" },
  });
  const store = distillation.createDistillationStore();
  await store.markDLQ(ownTask.id, "worker", "own failure", "parse_failed");
  await store.appendDLQ({
    taskId: ownTask.id,
    reason: "parse_failed",
    failureKind: "parse_failed",
    attempts: 0,
    error: "own failure",
    recordedAt: Date.now(),
  });
  await store.markDLQ(otherTask.id, "worker", "other failure", "parse_failed");
  await store.appendDLQ({
    taskId: otherTask.id,
    reason: "parse_failed",
    failureKind: "parse_failed",
    attempts: 0,
    error: "other failure",
    recordedAt: Date.now(),
  });

  const route = await import("../../src/app/api/memory/distillation-model/dlq/route.ts");
  const listed = await route.GET(
    new Request("http://localhost/api/memory/distillation-model/dlq", {
      headers: selfHeaders(),
    })
  );
  assert.equal(listed.status, 200);
  const body = await listed.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].ownerApiKeyId, selfRecord.id);

  const otherDlq = distillation.listDistillationDlqEntries({ scope: "other-owner" })[0]!;
  const denied = await route.POST(
    new Request("http://localhost/api/memory/distillation-model/dlq?op=retry", {
      method: "POST",
      headers: selfHeaders(),
      body: JSON.stringify({ ids: [String(otherDlq.id)] }),
    })
  );
  assert.equal(denied.status, 200);
  assert.deepEqual(
    { retried: (await denied.clone().json()).retried, skipped: (await denied.json()).skipped },
    { retried: 0, skipped: 1 }
  );

  const ownId = body.data[0].id as string;
  const retried = await route.POST(
    new Request("http://localhost/api/memory/distillation-model/dlq?op=retry", {
      method: "POST",
      headers: selfHeaders(),
      body: JSON.stringify({ ids: [ownId] }),
    })
  );
  const retriedBody = await retried.json();
  assert.equal(retriedBody.retried, 1);
  assert.equal(distillation.getDistillationTask(ownTask.id)?.status, "queued");
  assert.equal(distillation.getDistillationTask(otherTask.id)?.status, "failed_dlq");
});

test("distillation usage listing is owner-scoped and returns aggregate totals", async () => {
  const db = await import("../../src/memory/db/core.ts");
  const dbInstance = db.getMemoryDbInstance();
  const insert = dbInstance.prepare(
    `INSERT INTO distillation_usage (
      task_id, scope, kind, provider, model, tokens, usd, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const now = Date.now();
  insert.run(
    "own-task-1",
    selfRecord.id,
    "L2_scene",
    "openai",
    "gpt-4o-mini",
    100,
    0.01,
    now - 1000
  );
  insert.run(
    "own-task-2",
    selfRecord.id,
    "L3_persona",
    "openai",
    "gpt-4o-mini",
    200,
    0.02,
    now - 500
  );
  insert.run(
    "other-task-1",
    "other-owner",
    "L2_scene",
    "anthropic",
    "claude",
    50,
    0.005,
    now - 200
  );

  const route = await import("../../src/app/api/memory/distillation-model/usage/route.ts");
  const listed = await route.GET(
    new Request("http://localhost/api/memory/distillation-model/usage", {
      headers: selfHeaders(),
    })
  );
  assert.equal(listed.status, 200);
  const body = await listed.json();
  assert.equal(body.data.length, 2);
  assert.equal(body.totals.tokens, 300);
  assert.equal(body.totals.usd, 0.03);
  assert.equal(body.totals.tasks, 2);
  for (const row of body.data) {
    assert.equal(row.ownerApiKeyId, selfRecord.id);
    assert.ok(["L2_scene", "L3_persona"].includes(row.kind));
    assert.ok(row.provider === "openai" || row.provider === "anthropic");
  }

  // Cross-owner leakage: management caller targeting other-owner returns 0
  const crossOwner = await route.GET(
    new Request(`http://localhost/api/memory/distillation-model/usage?apiKeyId=other-owner`, {
      headers: managementHeaders(),
    })
  );
  assert.equal(crossOwner.status, 200);
  const crossBody = await crossOwner.json();
  assert.equal(crossBody.data.length, 1);
  assert.equal(crossBody.data[0].ownerApiKeyId, "other-owner");
  assert.equal(crossBody.totals.tokens, 50);

  // 401 on missing bearer
  const denied = await route.GET(
    new Request("http://localhost/api/memory/distillation-model/usage", {
      headers: { authorization: "Bearer not-a-real-key" },
    })
  );
  assert.equal(denied.status, 401);
});

test("L0 capture status is owner-scoped and exposes masked aggregate counters only", async () => {
  const telemetry = await import("../../src/memory/db/repositories/l0CaptureTelemetry.ts");
  telemetry.recordL0CaptureSuccess(selfRecord.id);
  telemetry.recordL0CaptureSuccess(selfRecord.id);
  // unknown category must be sanitized away, not persisted verbatim
  telemetry.recordL0CaptureFailure(selfRecord.id, "should-not-leak");
  telemetry.recordL0CaptureFailure(selfRecord.id, "storage_error");
  telemetry.recordL0CaptureSuccess("other-owner");

  const route = await import("../../src/app/api/memory/l0/status/route.ts");
  const response = await route.GET(
    new Request("http://localhost/api/memory/l0/status", { headers: selfHeaders() })
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.ownerApiKeyId, selfRecord.id);
  assert.equal(body.data.successCount, 2);
  assert.equal(body.data.failureCount, 2);
  assert.equal(body.data.lastFailureCategory, "storage_error");
  assert.ok(typeof body.data.lastSuccessAt === "string");
  assert.ok(typeof body.data.lastFailureAt === "string");

  // 401 on missing bearer
  const denied = await route.GET(
    new Request("http://localhost/api/memory/l0/status", {
      headers: { authorization: "Bearer not-a-real-key" },
    })
  );
  assert.equal(denied.status, 401);

  // response body MUST NOT contain content/tokens/secret-like fields
  const text = JSON.stringify(body);
  assert.equal(text.includes("content"), false);
  assert.equal(text.includes("token"), false);
  assert.equal(text.includes("secret"), false);
  assert.equal(text.includes("should-not-leak"), false);
});

test("storage errors are sanitized and do not expose absolute paths", async () => {
  dependencies.setFourLayerServiceForTesting({
    ...createFourLayerService(),
    createL1: async () => {
      throw new Error("at /secret/path/file.ts:42 — boom");
    },
  });
  const route = await import("../../src/app/api/memory/l1/route.ts");
  const response = await route.POST(
    new Request("http://localhost/api/memory/l1", {
      method: "POST",
      headers: selfHeaders(),
      body: JSON.stringify({
        type: "work_fact",
        content: "x",
        sceneName: "general",
        sourceMessageIds: [],
      }),
    })
  );
  assert.equal(response.status, 400);
  const body = JSON.stringify(await response.json());
  assert.equal(body.includes("/secret/path/file.ts"), false);
  assert.equal(/\sat\s+\//.test(body), false);
});

test("pipeline settings can be enabled per API key and reset to fallback", async () => {
  const route = await import("../../src/app/api/memory/pipeline-settings/route.ts");

  const initial = await route.GET(
    new Request("http://localhost/api/memory/pipeline-settings", { headers: selfHeaders() })
  );
  assert.equal(initial.status, 200);
  const initialData = (await initial.json()).data as Record<string, unknown>;
  assert.equal(initialData.captureEnabled, false);
  assert.equal(initialData.injectionEnabled, false);
  assert.equal(initialData.sourceLayer, "default");

  const saved = await route.PUT(
    new Request("http://localhost/api/memory/pipeline-settings", {
      method: "PUT",
      headers: selfHeaders(),
      body: JSON.stringify({ captureEnabled: true, injectionEnabled: true }),
    })
  );
  assert.equal(saved.status, 200);
  const savedData = (await saved.json()).data as Record<string, unknown>;
  assert.equal(savedData.captureEnabled, true);
  assert.equal(savedData.injectionEnabled, true);
  assert.equal(savedData.sourceLayer, "per-key");
  assert.equal(savedData.apiKeyId, selfRecord.id);

  const persisted = await route.GET(
    new Request("http://localhost/api/memory/pipeline-settings", { headers: selfHeaders() })
  );
  const persistedData = (await persisted.json()).data as Record<string, unknown>;
  assert.equal(persistedData.captureEnabled, true);
  assert.equal(persistedData.injectionEnabled, true);

  const reset = await route.DELETE(
    new Request("http://localhost/api/memory/pipeline-settings", {
      method: "DELETE",
      headers: selfHeaders(),
    })
  );
  assert.equal(reset.status, 200);
  const resetData = (await reset.json()).data as Record<string, unknown>;
  assert.equal(resetData.captureEnabled, false);
  assert.equal(resetData.injectionEnabled, false);
  assert.equal(resetData.sourceLayer, "default");
});
