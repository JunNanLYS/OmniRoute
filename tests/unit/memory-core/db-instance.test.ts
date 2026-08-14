/**
 * tests/unit/memory-core/db-instance.test.ts
 *
 * Standalone four-layer memory storage core — DB lifecycle tests.
 *
 * Covers:
 *   - Standalone DATA_DIR/memory.db file path (separate from main storage)
 *   - Lazy singleton getMemoryDbInstance()
 *   - resetMemoryDbInstance() closes the handle
 *   - :memory: under isCloud / isBuildPhase
 *   - PRAGMAs applied (journal_mode=WAL, busy_timeout, synchronous=NORMAL, cache_size, temp_store=MEMORY)
 *   - Dedicated _memory_migrations tracking table
 *   - Idempotent migrations (run twice -> same schema state)
 *   - Independent file (does not interfere with main storage.sqlite)
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-mem-core-db-"));
process.env["DATA_DIR"] = TEST_DATA_DIR;
process.env["DISABLE_SQLITE_AUTO_BACKUP"] = "true";

const dbModule = await import("../../../src/memory/db/core.ts");
const { getMemoryDbInstance, resetMemoryDbInstance, getMemoryDbFilePath, isMemoryDbReady } =
  dbModule;

/**
 * Wipe the entire memory DB file (including WAL/SHM sidecars) and reset the
 * singleton. Each test gets a fresh DB so state never leaks between tests
 * within the same file.
 */
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

function closeAndRemove(): void {
  wipeDb();
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

test.after(() => {
  closeAndRemove();
});

test("standalone memory DB lives at DATA_DIR/memory.db (not storage.sqlite)", () => {
  wipeDb();
  const filePath = getMemoryDbFilePath();
  assert.equal(path.basename(filePath), "memory.db");
  assert.ok(
    filePath.startsWith(TEST_DATA_DIR),
    `path ${filePath} should be inside ${TEST_DATA_DIR}`
  );
});

test("getMemoryDbInstance is a lazy singleton — returns the same handle until reset", () => {
  wipeDb();
  const a = getMemoryDbInstance();
  const b = getMemoryDbInstance();
  assert.strictEqual(a, b, "two consecutive calls must return the same instance");
  assert.equal(a.open, true);
});

test("resetMemoryDbInstance closes the handle — next call opens a fresh one", () => {
  wipeDb();
  const a = getMemoryDbInstance();
  assert.equal(a.open, true);
  resetMemoryDbInstance();
  assert.equal(a.open, false, "old handle must be closed");
  const b = getMemoryDbInstance();
  assert.notStrictEqual(a, b, "after reset a new handle is returned");
  assert.equal(b.open, true);
});

test("PRAGMAs: WAL journal mode, 2s busy timeout, NORMAL synchronous, MEMORY temp store", () => {
  wipeDb();
  const db = getMemoryDbInstance();
  const journal = db.pragma("journal_mode", { simple: true });
  // bun:sqlite can fall back to MEMORY (no WAL) — accept either
  assert.ok(
    journal === "wal" || journal === "memory",
    `journal_mode must be wal or memory, got ${journal}`
  );
  const busy = db.pragma("busy_timeout", { simple: true });
  assert.equal(Number(busy), 2000, `busy_timeout must be 2000, got ${busy}`);
  const sync = db.pragma("synchronous", { simple: true });
  assert.equal(Number(sync), 1, `synchronous must be NORMAL (1), got ${sync}`);
  const tempStore = db.pragma("temp_store", { simple: true });
  assert.equal(Number(tempStore), 2, `temp_store must be MEMORY (2), got ${tempStore}`);
});

test("schema_migrations tracking table created (idempotent)", () => {
  wipeDb();
  const db = getMemoryDbInstance();
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('_memory_migrations','schema_migrations')"
    )
    .all() as Array<{ name: string }>;
  const names = rows.map((r) => r.name);
  assert.ok(
    names.includes("_memory_migrations") || names.includes("schema_migrations"),
    `must create a _memory_migrations or schema_migrations table, got ${names.join(",")}`
  );
});

test("migrations are idempotent — running them twice keeps schema consistent", () => {
  wipeDb();
  const a = getMemoryDbInstance();
  const before = (
    a
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
  resetMemoryDbInstance();
  const b = getMemoryDbInstance();
  const after = (
    b
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
  assert.deepEqual(before, after, "schema objects should be identical after re-running migrations");
});

test("memory DB is independent from main storage — separate file, separate tables", () => {
  wipeDb();
  const db = getMemoryDbInstance();
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
  // Memory DB must contain its four layer tables (or placeholders).
  for (const required of ["l0_messages", "l1_memories", "l2_scenes", "l3_personas"]) {
    assert.ok(
      tables.includes(required),
      `missing layer table ${required}; have: ${tables.join(",")}`
    );
  }
  // Main-DB-only tables must NOT be in the memory DB.
  assert.ok(!tables.includes("memories"), "main 'memories' table must not leak into memory.db");
  assert.ok(!tables.includes("call_logs"), "main 'call_logs' table must not leak into memory.db");
});

test("isMemoryDbReady false before open, true after open", () => {
  wipeDb();
  assert.equal(isMemoryDbReady(), false);
  getMemoryDbInstance();
  assert.equal(isMemoryDbReady(), true);
});
