import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-memory-production-"));
process.env["DATA_DIR"] = TEST_DATA_DIR;
process.env["DISABLE_SQLITE_AUTO_BACKUP"] = "true";

const dependencies = await import("../../src/memory/api/dependencies.ts");
const recall = await import("../../src/memory/recall/facade.ts");
const core = await import("../../src/memory/db/core.ts");
const l0 = await import("../../src/memory/l0.ts");
const l1 = await import("../../src/memory/l1.ts");
const l2 = await import("../../src/memory/l2.ts");
const l3 = await import("../../src/memory/l3.ts");
const runtime = await import("../../src/memory/integration/runtime.ts");

const OWNER_ID = "api-key-owner";

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

test.afterEach(() => {
  dependencies.resetFourLayerServiceForTesting();
  recall.resetRecallProviderForTests();
  wipeDb();
});

test.after(() => {
  core.resetMemoryDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("production four-layer API service is wired to standalone memory storage", () => {
  assert.equal(dependencies.isNoOpService(), false);
  assert.doesNotThrow(() => dependencies.getFourLayerService());
});

test("production recall provider reads L1, L2, and L3 from standalone memory storage", async () => {
  wipeDb();
  const owner = runtime.ownerFromApiKeyId(OWNER_ID);

  l1.createMemory({
    owner,
    type: "work_fact",
    priority: 90,
    sceneName: "project",
    sourceMessageIds: [],
    metadata: { tags: ["typescript"] },
    content: "The project uses TypeScript",
    lastModifiedBy: "user",
    editedByUser: true,
  });
  l2.createScene({
    owner,
    sceneName: "project",
    summary: "Current project context",
    heat: 0.8,
    content: "Project scene details",
    lastModifiedBy: "pipeline",
    editedByUser: false,
  });
  l3.upsertPersona({
    owner,
    content: "Prefer concise technical answers",
    promptMode: "code",
    lastModifiedBy: "user",
    editedByUser: true,
  });

  assert.notEqual(recall.getRecallProvider(), recall.NOOP_RECALL_PROVIDER);
  const out = await recall.recallLayeredContext(
    { ownerId: OWNER_ID, sessionId: "session-1", query: "TypeScript" },
    { timeoutMs: 500 }
  );

  assert.equal(out.l1Status, "ok");
  assert.equal(out.layers.l1[0]?.content, "The project uses TypeScript");
  assert.deepEqual(out.layers.l1[0]?.tags, ["typescript"]);
  assert.equal(out.layers.l2[0]?.title, "project");
  assert.equal(out.layers.l2[0]?.summary, "Current project context");
  assert.equal(out.layers.l3[0]?.content, "Prefer concise technical answers");
});

test("production L0 capture store persists records in standalone memory storage", async () => {
  wipeDb();
  const store = runtime.getProductionL0MessageStore();
  const now = new Date().toISOString();

  await store.insert({
    id: "l0-idempotency-key",
    ownerId: OWNER_ID,
    sessionId: "session-1",
    role: "user",
    content: "Persist this turn",
    metadata: {
      session_key: "session-1",
      pipelineSessionId: "session-1",
      user_id: OWNER_ID,
      role: "user",
      source: "chat",
      timestamp: now,
      correlation_id: "corr-1",
      combo_execution_key: null,
      is_internal: false,
      provider: "openai",
      model: "gpt-4o-mini",
    },
    createdAt: now,
  });

  const rows = l0.listMessages({
    owner: runtime.ownerFromApiKeyId(OWNER_ID),
    sessionId: "session-1",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.content, "Persist this turn");
  assert.equal(rows[0]?.id, "l0-idempotency-key");
  assert.equal(rows[0]?.idempotencyKey, "l0-idempotency-key");
});
