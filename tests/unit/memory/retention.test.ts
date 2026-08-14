import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-memory-retention-"));
process.env["DATA_DIR"] = TEST_DATA_DIR;
process.env["DISABLE_SQLITE_AUTO_BACKUP"] = "true";

const core = await import("../../../src/memory/db/core.ts");
const l0 = await import("../../../src/memory/l0.ts");
const l1 = await import("../../../src/memory/l1.ts");
const retention = await import("../../../src/memory/integration/retentionCleaner.ts");
const { ownerFromApiKeyId } = await import("../../../src/memory/integration/runtime.ts");

function wipeDb(): void {
  core.resetMemoryDbInstance();
  const filePath = core.getMemoryDbFilePath();
  if (filePath === ":memory:") return;
  for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`, `${filePath}-journal`]) {
    try {
      fs.unlinkSync(candidate);
    } catch {
      // File may not exist yet.
    }
  }
}

function insertL0(id: string, ownerId: string, content: string): void {
  l0.insertMessage({
    id,
    owner: ownerFromApiKeyId(ownerId),
    sessionKey: "session-a",
    sessionId: "session-a",
    role: "user",
    content,
    source: "user",
    correlationId: `corr-${id}`,
    comboExecutionKey: null,
    isInternal: false,
    provider: "openai",
    model: "gpt-4o-mini",
    truncated: false,
    idempotencyKey: id,
    timestamp: "2026-01-01T00:00:00.000Z",
  });
}

function createL1(ownerId: string, content: string) {
  return l1.createMemory({
    owner: ownerFromApiKeyId(ownerId),
    type: "work_fact",
    content,
    priority: 50,
    sceneName: "project-a",
    sourceMessageIds: [],
    metadata: {},
    lastModifiedBy: "pipeline",
    editedByUser: false,
  });
}

test.beforeEach(async () => {
  await retention.stopMemoryRetentionCleaner();
  wipeDb();
});

test.afterEach(async () => {
  await retention.stopMemoryRetentionCleaner();
  wipeDb();
});

test.after(async () => {
  await retention.stopMemoryRetentionCleaner();
  core.resetMemoryDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("retention days are disabled unless configured as positive whole days", () => {
  assert.equal(retention.parseMemoryRetentionDays(undefined), null);
  assert.equal(retention.parseMemoryRetentionDays(""), null);
  assert.equal(retention.parseMemoryRetentionDays("0"), null);
  assert.equal(retention.parseMemoryRetentionDays("-1"), null);
  assert.equal(retention.parseMemoryRetentionDays("1.5"), null);
  assert.equal(retention.parseMemoryRetentionDays("not-a-number"), null);
  assert.equal(retention.parseMemoryRetentionDays(" 30 "), 30);
});

test("missing or invalid retention configuration does not open or mutate memory.db", () => {
  assert.equal(core.isMemoryDbReady(), false);

  const result = retention.runMemoryRetentionCleanup({
    env: {
      MEMORY_L0_RETENTION: "0",
      MEMORY_L1_RETENTION: "invalid",
    },
    now: Date.parse("2026-08-14T00:00:00.000Z"),
  });

  assert.deepEqual(result, {
    deletedL0Messages: 0,
    deletedL1Memories: 0,
    deletedL1Versions: 0,
  });
  assert.equal(core.isMemoryDbReady(), false);
});

test("L0 retention permanently removes only messages older than the configured age", () => {
  const ownerId = "retention-l0-owner";
  const owner = ownerFromApiKeyId(ownerId);
  insertL0("l0-expired", ownerId, "expired-retention-message");
  insertL0("l0-fresh", ownerId, "fresh-retention-message");
  const db = core.getMemoryDbInstance();
  db.prepare("UPDATE l0_messages SET recorded_at = ? WHERE id = ?").run(
    "2026-06-01 00:00:00",
    "l0-expired"
  );
  db.prepare("UPDATE l0_messages SET recorded_at = ? WHERE id = ?").run(
    "2026-08-01 00:00:00",
    "l0-fresh"
  );

  const result = retention.runMemoryRetentionCleanup({
    env: { MEMORY_L0_RETENTION: "30" },
    now: Date.parse("2026-08-14T00:00:00.000Z"),
  });

  assert.deepEqual(result, {
    deletedL0Messages: 1,
    deletedL1Memories: 0,
    deletedL1Versions: 0,
  });
  assert.equal(l0.getMessageById("l0-expired", owner), null);
  assert.equal(l0.getMessageById("l0-fresh", owner)?.content, "fresh-retention-message");
  assert.equal(l0.searchMessages({ owner, query: "expired-retention-message" }).length, 0);
});

test("L0 retention strictly keeps records at the cutoff and removes only older rows", () => {
  const ownerId = "retention-boundary-owner";
  const owner = ownerFromApiKeyId(ownerId);
  insertL0("boundary-expired", ownerId, "boundary-expired-message");
  insertL0("boundary-equal", ownerId, "boundary-equal-message");
  insertL0("boundary-fresh", ownerId, "boundary-fresh-message");
  const db = core.getMemoryDbInstance();
  const cutoff = "2026-07-15T00:00:00.000Z";
  db.prepare("UPDATE l0_messages SET recorded_at = ? WHERE id = ?").run(
    "2026-07-14T23:59:59.999Z",
    "boundary-expired"
  );
  db.prepare("UPDATE l0_messages SET recorded_at = ? WHERE id = ?").run(cutoff, "boundary-equal");
  db.prepare("UPDATE l0_messages SET recorded_at = ? WHERE id = ?").run(
    "2026-07-15T00:00:00.001Z",
    "boundary-fresh"
  );

  const result = retention.runMemoryRetentionCleanup({
    env: { MEMORY_L0_RETENTION: "30" },
    now: Date.parse("2026-08-14T00:00:00.000Z"),
  });

  assert.deepEqual(result, {
    deletedL0Messages: 1,
    deletedL1Memories: 0,
    deletedL1Versions: 0,
  });
  assert.equal(l0.getMessageById("boundary-expired", owner), null);
  assert.equal(l0.getMessageById("boundary-equal", owner)?.content, "boundary-equal-message");
  assert.equal(l0.getMessageById("boundary-fresh", owner)?.content, "boundary-fresh-message");
});

test("L1 retention removes every version of expired stable ids and preserves fresh histories", () => {
  const ownerId = "retention-l1-owner";
  const owner = ownerFromApiKeyId(ownerId);
  const expired = createL1(ownerId, "expired-memory-version-one");
  l1.updateMemory(expired.id, owner, { content: "expired-memory-version-two" }, expired.version);
  const fresh = createL1(ownerId, "fresh-memory-version-one");
  l1.updateMemory(fresh.id, owner, { content: "fresh-memory-version-two" }, fresh.version);

  const db = core.getMemoryDbInstance();
  db.prepare("UPDATE l1_memories SET updated_at = ? WHERE id = ?").run(
    "2026-06-01T00:00:00.000Z",
    expired.id
  );
  db.prepare("UPDATE l1_memories SET updated_at = ? WHERE id = ? AND version = 1").run(
    "2026-06-01T00:00:00.000Z",
    fresh.id
  );
  db.prepare("UPDATE l1_memories SET updated_at = ? WHERE id = ? AND version = 2").run(
    "2026-08-01T00:00:00.000Z",
    fresh.id
  );

  const result = retention.runMemoryRetentionCleanup({
    env: { MEMORY_L1_RETENTION: "30" },
    now: Date.parse("2026-08-14T00:00:00.000Z"),
  });

  assert.deepEqual(result, {
    deletedL0Messages: 0,
    deletedL1Memories: 1,
    deletedL1Versions: 2,
  });
  assert.deepEqual(l1.getMemoryHistory(expired.id, owner), []);
  assert.equal(l1.getMemoryHistory(fresh.id, owner).length, 2);
  assert.equal(l1.getMemoryById(fresh.id, owner)?.content, "fresh-memory-version-two");
  assert.equal(l1.searchMemories({ owner, query: "expired-memory-version-two" }).length, 0);
});

test("the background cleaner starts only when retention is enabled and production gates allow it", async () => {
  const disabled = await retention.startMemoryRetentionCleaner({
    env: {},
    runtime: { allowAutomatedTestProcess: true },
  });
  assert.equal(disabled, false);

  const backgroundDisabled = await retention.startMemoryRetentionCleaner({
    env: {
      MEMORY_L0_RETENTION: "30",
      OMNIROUTE_DISABLE_BACKGROUND_SERVICES: "true",
    },
    runtime: { allowAutomatedTestProcess: true },
  });
  assert.equal(backgroundDisabled, false);

  const build = await retention.startMemoryRetentionCleaner({
    env: { MEMORY_L0_RETENTION: "30" },
    runtime: { allowAutomatedTestProcess: true, isBuildProcess: true },
  });
  assert.equal(build, false);

  const cloud = await retention.startMemoryRetentionCleaner({
    env: { MEMORY_L0_RETENTION: "30" },
    runtime: { allowAutomatedTestProcess: true, isCloudRuntime: true },
  });
  assert.equal(cloud, false);
});

test("the background cleaner is idempotent, unreferences timers, and stops safely", async () => {
  type Callback = () => void;
  type Handle = { kind: "timeout" | "interval"; unref(): void };
  let initialCallback: Callback | null = null;
  let intervalCallback: Callback | null = null;
  const cleared: Handle[] = [];
  let unrefCalls = 0;
  let cleanupRuns = 0;

  const schedule = {
    setTimeout(callback: Callback): Handle {
      initialCallback = callback;
      return { kind: "timeout", unref: () => unrefCalls++ };
    },
    setInterval(callback: Callback): Handle {
      intervalCallback = callback;
      return { kind: "interval", unref: () => unrefCalls++ };
    },
    clearTimeout(handle: Handle): void {
      cleared.push(handle);
    },
    clearInterval(handle: Handle): void {
      cleared.push(handle);
    },
  };

  const options = {
    env: { MEMORY_L0_RETENTION: "30" },
    runtime: { allowAutomatedTestProcess: true },
    schedule,
    cleanup: async () => {
      cleanupRuns++;
      return {
        deletedL0Messages: 0,
        deletedL1Memories: 0,
        deletedL1Versions: 0,
      };
    },
    logger: { warn() {} },
  };

  assert.equal(await retention.startMemoryRetentionCleaner(options), true);
  assert.equal(await retention.startMemoryRetentionCleaner(options), false);
  assert.equal(unrefCalls, 2);
  assert.ok(initialCallback);
  assert.ok(intervalCallback);

  initialCallback!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleanupRuns, 1);

  await retention.stopMemoryRetentionCleaner();
  await retention.stopMemoryRetentionCleaner();
  assert.deepEqual(cleared.map((handle) => handle.kind).sort(), ["interval", "timeout"]);
});
