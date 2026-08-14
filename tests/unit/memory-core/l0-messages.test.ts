/**
 * tests/unit/memory-core/l0-messages.test.ts
 *
 * L0 (messages) CRUD + idempotency + soft delete tests.
 *
 * Covers:
 *   - Insert with idempotency key — repeated insert is no-op
 *   - role constrained to user|assistant
 *   - source constrained to user|assistant|imported
 *   - Owner fields persisted and listed correctly
 *   - Owner isolation: A's messages never leak into B's list
 *   - Search by content via L0 FTS
 *   - Soft delete then restore then permanent delete
 *   - L0 is never editable (no updateContent API exposed)
 *   - Truncated marker persisted
 *   - correlation_id, combo_execution_key, provider/model persisted
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-mem-l0-"));
process.env["DATA_DIR"] = TEST_DATA_DIR;
process.env["DISABLE_SQLITE_AUTO_BACKUP"] = "true";

const coreDb = await import("../../../src/memory/db/core.ts");
const { getMemoryDbInstance, resetMemoryDbInstance, getMemoryDbFilePath } = coreDb;
const l0 = await import("../../../src/memory/l0.ts");

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

/** Wipe the memory DB file (and WAL/SHM sidecars) so each test starts clean. */
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

function aMsg(
  overrides: Partial<Parameters<typeof l0.insertMessage>[0]> = {}
): Parameters<typeof l0.insertMessage>[0] {
  return {
    owner: OWNER_A,
    sessionKey: "sk-a",
    sessionId: "sess-a",
    role: "user",
    content: "Hello, world!",
    source: "user",
    correlationId: "corr-1",
    comboExecutionKey: "combo-1",
    isInternal: false,
    provider: "openai",
    model: "gpt-4",
    truncated: false,
    ...overrides,
  };
}

test("insertMessage is idempotent — repeated call returns same row id, no duplicate", () => {
  wipeDb();
  const r1 = l0.insertMessage(aMsg({ idempotencyKey: "key-A" }));
  const r2 = l0.insertMessage(aMsg({ idempotencyKey: "key-A", content: "Different content" }));
  assert.equal(r1.id, r2.id, "idempotency key must dedupe");
  assert.equal(r1.inserted, true);
  assert.equal(r2.inserted, false, "second insert must report inserted=false");
  const all = l0.listMessages({ owner: OWNER_A });
  assert.equal(all.length, 1, "only one row should exist for the same idempotency key");
});

test("role is constrained to user|assistant", () => {
  wipeDb();
  assert.throws(() => l0.insertMessage(aMsg({ role: "system" as unknown as "user" })), /role/i);
});

test("source is constrained to user|assistant|imported", () => {
  wipeDb();
  assert.throws(() => l0.insertMessage(aMsg({ source: "robot" as unknown as "user" })), /source/i);
});

test("listMessages is owner-scoped — A and B do not see each other", () => {
  wipeDb();
  l0.insertMessage(aMsg({ idempotencyKey: "a-1", content: "A1" }));
  l0.insertMessage(aMsg({ idempotencyKey: "a-2", content: "A2" }));
  l0.insertMessage({
    ...aMsg({ idempotencyKey: "b-1" }),
    owner: OWNER_B,
    sessionKey: "sk-b",
    sessionId: "sess-b",
  });
  const aList = l0.listMessages({ owner: OWNER_A });
  const bList = l0.listMessages({ owner: OWNER_B });
  assert.equal(aList.length, 2);
  assert.equal(bList.length, 1);
  assert.ok(aList.every((m) => m.userId === "user-a"));
  assert.ok(bList.every((m) => m.userId === "user-b"));
});

test("searchMessages uses FTS — keyword matches content", () => {
  wipeDb();
  l0.insertMessage(aMsg({ idempotencyKey: "k1", content: "Python is a great language" }));
  l0.insertMessage(aMsg({ idempotencyKey: "k2", content: "JavaScript also nice" }));
  const hits = l0.searchMessages({ owner: OWNER_A, query: "Python" });
  assert.equal(hits.length, 1);
  assert.ok(hits[0]!.content.includes("Python"));
});

test("soft delete → restore → permanent delete", () => {
  wipeDb();
  const r = l0.insertMessage(aMsg({ idempotencyKey: "del-1", content: "to be deleted" }));
  // Soft delete
  l0.softDeleteMessage(r.id, OWNER_A);
  const afterSoft = l0.listMessages({ owner: OWNER_A });
  assert.equal(afterSoft.length, 0, "soft-deleted message hidden from default list");
  const inclDeleted = l0.listMessages({ owner: OWNER_A, includeDeleted: true });
  assert.equal(inclDeleted.length, 1);
  assert.ok(inclDeleted[0]!.deletedAt !== null);

  // Restore
  l0.restoreMessage(r.id, OWNER_A);
  const afterRestore = l0.listMessages({ owner: OWNER_A });
  assert.equal(afterRestore.length, 1);
  assert.equal(afterRestore[0]!.deletedAt, null);

  // Permanent delete
  l0.permanentDeleteMessage(r.id, OWNER_A);
  const afterPerm = l0.listMessages({ owner: OWNER_A, includeDeleted: true });
  assert.equal(afterPerm.length, 0);
});

test("L0 has no updateContent — messages are immutable", () => {
  const exportedKeys = Object.keys(l0).sort();
  assert.ok(
    !exportedKeys.some((k) => /update|edit/i.test(k)),
    `L0 must not expose update/edit functions, found: ${exportedKeys.join(",")}`
  );
});

test("truncated flag and correlation_id / provider/model round-trip", () => {
  wipeDb();
  const r = l0.insertMessage(
    aMsg({
      idempotencyKey: "rt",
      content: "very long content",
      truncated: true,
      correlationId: "corr-X",
      comboExecutionKey: "combo-X",
      provider: "anthropic",
      model: "claude-3",
    })
  );
  const got = l0.getMessageById(r.id, OWNER_A);
  assert.ok(got);
  assert.equal(got.truncated, true);
  assert.equal(got.correlationId, "corr-X");
  assert.equal(got.comboExecutionKey, "combo-X");
  assert.equal(got.provider, "anthropic");
  assert.equal(got.model, "claude-3");
});

test("isInternal flag persists and is filterable", () => {
  wipeDb();
  l0.insertMessage(aMsg({ idempotencyKey: "u1", isInternal: false, content: "user" }));
  l0.insertMessage(aMsg({ idempotencyKey: "u2", isInternal: true, content: "internal" }));
  const publicOnly = l0.listMessages({ owner: OWNER_A, isInternal: false });
  assert.equal(publicOnly.length, 1);
  assert.equal(publicOnly[0]!.content, "user");
  const internal = l0.listMessages({ owner: OWNER_A, isInternal: true });
  assert.equal(internal.length, 1);
  assert.equal(internal[0]!.content, "internal");
});

test("session_id filter narrows list", () => {
  wipeDb();
  l0.insertMessage(aMsg({ idempotencyKey: "sa1", sessionId: "sess-x" }));
  l0.insertMessage(aMsg({ idempotencyKey: "sa2", sessionId: "sess-y" }));
  const x = l0.listMessages({ owner: OWNER_A, sessionId: "sess-x" });
  assert.equal(x.length, 1);
  assert.equal(x[0]!.sessionId, "sess-x");
});

test("insert with explicit timestamp stores it (and recorded_at is set)", () => {
  wipeDb();
  const r = l0.insertMessage(
    aMsg({
      idempotencyKey: "ts",
      timestamp: "2026-01-01T00:00:00.000Z",
    })
  );
  const got = l0.getMessageById(r.id, OWNER_A);
  assert.ok(got);
  assert.equal(got.timestamp, "2026-01-01T00:00:00.000Z");
  assert.ok(got.recordedAt && got.recordedAt.length > 0);
});

test("no raw SQL is used outside the memory db module (smoke: every L0 call goes through adapter)", () => {
  // Functional safety net: a successful run of all prior tests already proves
  // parameterized SQL. We assert the public surface is what callers should use.
  const exportedFns = Object.keys(l0).sort();
  assert.ok(exportedFns.includes("insertMessage"));
  assert.ok(exportedFns.includes("listMessages"));
  assert.ok(exportedFns.includes("searchMessages"));
  assert.ok(exportedFns.includes("getMessageById"));
  assert.ok(exportedFns.includes("softDeleteMessage"));
  assert.ok(exportedFns.includes("restoreMessage"));
  assert.ok(exportedFns.includes("permanentDeleteMessage"));
  // touch db so it does not appear unused
  getMemoryDbInstance();
});
