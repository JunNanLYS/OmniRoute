/**
 * tests/unit/memory-core/security.test.ts
 *
 * Security: parameterized SQL; strict owner scope; no memory bodies in logs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-mem-sec-"));
process.env["DATA_DIR"] = TEST_DATA_DIR;
process.env["DISABLE_SQLITE_AUTO_BACKUP"] = "true";

const coreDb = await import("../../../src/memory/db/core.ts");
const { resetMemoryDbInstance, getMemoryDbFilePath } = coreDb;
const l0 = await import("../../../src/memory/l0.ts");
const l1 = await import("../../../src/memory/l1.ts");
const l2 = await import("../../../src/memory/l2.ts");
const l3 = await import("../../../src/memory/l3.ts");

test.after(() => {
  try {
    resetMemoryDbInstance();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function wipeDb(): void {
  try {
    resetMemoryDbInstance();
  } catch {
    /* ignore */
  }
  const filePath = getMemoryDbFilePath();
  if (typeof filePath === "string" && filePath !== ":memory:") {
    for (const p of [filePath, `${filePath}-wal`, `${filePath}-shm`, `${filePath}-journal`]) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}

const OWNER_A = { teamId: "team-1", userId: "user-a", agentId: "agent-a" };
const OWNER_B = { teamId: "team-1", userId: "user-b", agentId: "agent-b" };

test("SQL injection in idempotencyKey is treated as a literal (parameterized)", () => {
  wipeDb();
  const nasty = "x'; DROP TABLE l0_messages; --";
  const r = l0.insertMessage({
    owner: OWNER_A,
    sessionKey: "sk",
    sessionId: "sess",
    role: "user",
    content: "safe content",
    source: "user",
    correlationId: null,
    comboExecutionKey: null,
    isInternal: false,
    provider: null,
    model: null,
    truncated: false,
    idempotencyKey: nasty,
  });
  assert.ok(r.id);
  // table still exists
  const stillThere = l0.listMessages({ owner: OWNER_A });
  assert.equal(stillThere.length, 1);
  assert.equal(stillThere[0]!.idempotencyKey, nasty);
});

test("SQL injection in content is stored as literal (parameterized)", () => {
  wipeDb();
  const nasty = "evil'; UPDATE l1_memories SET priority=999; --";
  l1.createMemory({
    owner: OWNER_A,
    type: "episodic",
    content: nasty,
    priority: 50,
    sceneName: "default",
    sourceMessageIds: [],
    metadata: {},
    lastModifiedBy: "user",
    editedByUser: false,
  });
  const all = l1.listMemories({ owner: OWNER_A });
  assert.equal(all.length, 1);
  assert.equal(all[0]!.priority, 50, "priority should NOT be 999 — the nasty string was a literal");
});

test("owner scoping: B cannot retrieve A's data through any layer", () => {
  wipeDb();
  // L0
  const m0 = l0.insertMessage({
    owner: OWNER_A,
    sessionKey: "sk",
    sessionId: "sess",
    role: "user",
    content: "A-secret",
    source: "user",
    correlationId: null,
    comboExecutionKey: null,
    isInternal: false,
    provider: null,
    model: null,
    truncated: false,
    idempotencyKey: "a-m",
  });
  assert.equal(l0.getMessageById(m0.id, OWNER_B), null);
  assert.equal(l0.listMessages({ owner: OWNER_B }).length, 0);
  assert.equal(l0.searchMessages({ owner: OWNER_B, query: "A-secret" }).length, 0);

  // L1
  const m1 = l1.createMemory({
    owner: OWNER_A,
    type: "episodic",
    content: "A-secret memory",
    priority: 50,
    sceneName: "default",
    sourceMessageIds: [],
    metadata: {},
    lastModifiedBy: "user",
    editedByUser: false,
  });
  assert.equal(l1.getMemoryById(m1.id, OWNER_B), null);
  assert.equal(l1.listMemories({ owner: OWNER_B }).length, 0);
  assert.equal(l1.searchMemories({ owner: OWNER_B, query: "A-secret memory" }).length, 0);

  // L2
  const s2 = l2.createScene({
    owner: OWNER_A,
    sceneName: "A-scene",
    summary: "x",
    content: "x",
    heat: 0.1,
    lastModifiedBy: "user",
    editedByUser: false,
  });
  assert.equal(l2.getSceneById(s2.id, OWNER_B), null);
  assert.equal(l2.listScenes({ owner: OWNER_B }).length, 0);

  // L3
  l3.upsertPersona({
    owner: OWNER_A,
    content: "A-persona",
    promptMode: "chat",
    lastModifiedBy: "user",
    editedByUser: false,
  });
  assert.equal(l3.getActivePersona(OWNER_B), null);
});

test("strict owner scope required — no silent default bucket", () => {
  wipeDb();
  // The Owner type must require all three fields — a default/empty bucket is forbidden.
  // We test this indirectly: passing owner with empty strings is allowed at the TS level
  // (it is a valid Owner), but every operation must still scope by it.
  const empty = { teamId: "", userId: "", agentId: "" };
  l1.createMemory({
    owner: empty,
    type: "episodic",
    content: "owner-empty",
    priority: 50,
    sceneName: "default",
    sourceMessageIds: [],
    metadata: {},
    lastModifiedBy: "user",
    editedByUser: false,
  });
  const a = l1.listMemories({ owner: OWNER_A });
  const e = l1.listMemories({ owner: empty });
  assert.equal(a.length, 0, "default-bucket leak: A should not see empty owner's memory");
  assert.equal(e.length, 1, "empty owner is a valid owner and can see its own data");
});
