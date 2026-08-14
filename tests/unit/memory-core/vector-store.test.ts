/**
 * tests/unit/memory-core/vector-store.test.ts
 *
 * Vector store — best-effort / degradable.
 * The vector store is gated by VECTOR_STORE_DISABLE_VEC; when disabled (as in our tests
 * for determinism), the public getMemoryVectorStore() returns null and FTS5 remains the
 * authoritative retrieval path. We assert that contract here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-mem-vec-"));
process.env["DATA_DIR"] = TEST_DATA_DIR;
process.env["VECTOR_STORE_DISABLE_VEC"] = "true";
process.env["DISABLE_SQLITE_AUTO_BACKUP"] = "true";

const coreDb = await import("../../../src/memory/db/core.ts");
const { resetMemoryDbInstance, getMemoryDbFilePath } = coreDb;
const vec = await import("../../../src/memory/vectorStore.ts");
const l1Mod = await import("../../../src/memory/l1.ts");

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

test("getMemoryVectorStore honors VECTOR_STORE_DISABLE_VEC and returns null", () => {
  wipeDb();
  vec.resetMemoryVectorStore();
  const store = vec.getMemoryVectorStore();
  assert.equal(store, null, "vector store must be null when VECTOR_STORE_DISABLE_VEC=true");
});

test("resetMemoryVectorStore clears the cached singleton", () => {
  wipeDb();
  vec.resetMemoryVectorStore();
  const first = vec.getMemoryVectorStore();
  assert.equal(first, null);
  vec.resetMemoryVectorStore();
  const second = vec.getMemoryVectorStore();
  assert.equal(second, null);
});

test("FTS5 still works when vector store is disabled (degradation contract)", () => {
  wipeDb();
  l1Mod.createMemory({
    owner: { teamId: "t1", userId: "u1", agentId: "a1" },
    type: "episodic",
    content: "PostgreSQL is a great database",
    priority: 50,
    sceneName: "default",
    sourceMessageIds: [],
    metadata: {},
    lastModifiedBy: "user",
    editedByUser: false,
  });
  const hits = l1Mod.searchMemories({
    owner: { teamId: "t1", userId: "u1", agentId: "a1" },
    query: "PostgreSQL",
  });
  assert.equal(hits.length, 1, "FTS5 must always work even when vectors are disabled");
});
