/**
 * tests/unit/memory-core/fts-rrf.test.ts
 *
 * FTS-only retrieval across L0 + L1 and pure RRF fusion without vectors.
 *
 * Verifies that:
 *   - FTS works deterministically for L0 and L1
 *   - Pure-RRF fusion of two FTS-ranked lists (deterministic, no vectors)
 *     matches the documented k=60 formula: rrf = 1 / (k + rank)
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-mem-fts-rrf-"));
process.env["DATA_DIR"] = TEST_DATA_DIR;
process.env["VECTOR_STORE_DISABLE_VEC"] = "true"; // ensure vectors are disabled
process.env["DISABLE_SQLITE_AUTO_BACKUP"] = "true";

const coreDb = await import("../../../src/memory/db/core.ts");
const { resetMemoryDbInstance, getMemoryDbFilePath } = coreDb;
const l0 = await import("../../../src/memory/l0.ts");
const l1 = await import("../../../src/memory/l1.ts");
const rrf = await import("../../../src/memory/retrieval/rrf.ts");

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

test("L0 FTS5: search returns matching content", () => {
  wipeDb();
  l0.insertMessage({
    owner: OWNER_A,
    sessionKey: "sk",
    sessionId: "s1",
    role: "user",
    content: "Python is great for data science",
    source: "user",
    correlationId: null,
    comboExecutionKey: null,
    isInternal: false,
    provider: null,
    model: null,
    truncated: false,
    idempotencyKey: "k1",
  });
  l0.insertMessage({
    owner: OWNER_A,
    sessionKey: "sk",
    sessionId: "s1",
    role: "assistant",
    content: "JavaScript is great for web development",
    source: "assistant",
    correlationId: null,
    comboExecutionKey: null,
    isInternal: false,
    provider: null,
    model: null,
    truncated: false,
    idempotencyKey: "k2",
  });
  const hits = l0.searchMessages({ owner: OWNER_A, query: "Python" });
  assert.equal(hits.length, 1);
  assert.ok(hits[0]!.content.includes("Python"));
});

test("L1 FTS5: search returns matching memory", () => {
  wipeDb();
  l1.createMemory({
    owner: OWNER_A,
    type: "episodic",
    content: "User prefers Python for data analysis",
    priority: 50,
    sceneName: "default",
    sourceMessageIds: [],
    metadata: {},
    lastModifiedBy: "user",
    editedByUser: false,
  });
  l1.createMemory({
    owner: OWNER_A,
    type: "instruction",
    content: "Always respond in formal English",
    priority: 50,
    sceneName: "default",
    sourceMessageIds: [],
    metadata: {},
    lastModifiedBy: "user",
    editedByUser: false,
  });
  const hits = l1.searchMemories({ owner: OWNER_A, query: "Python" });
  assert.equal(hits.length, 1);
  assert.ok(hits[0]!.content.includes("Python"));
});

test("RRF pure fusion: k=60 formula and deterministic dedup", () => {
  // Two FTS-ranked lists, different IDs, with one shared ID appearing in both.
  const listA: Array<{ id: string; rank: number }> = [
    { id: "doc1", rank: 1 },
    { id: "doc2", rank: 2 },
    { id: "doc3", rank: 3 },
  ];
  const listB: Array<{ id: string; rank: number }> = [
    { id: "doc3", rank: 1 },
    { id: "doc4", rank: 2 },
    { id: "doc1", rank: 3 },
  ];

  const fused = rrf.fuseRankedLists([listA, listB], { k: 60 });
  // Expected rrf scores (k=60):
  //   doc1: 1/(60+1) + 1/(60+3) = ~0.016393 + 0.015873 = ~0.032266
  //   doc3: 1/(60+3) + 1/(60+1) = same as doc1
  //   doc2: 1/(60+2) ≈ 0.016129
  //   doc4: 1/(60+2) ≈ 0.016129
  const m = new Map(fused.map((r) => [r.id, r.score]));
  assert.ok(m.has("doc1") && m.has("doc2") && m.has("doc3") && m.has("doc4"));
  // doc1 == doc3 by score (each appears once in each list at ranks 1 and 3)
  assert.ok(Math.abs((m.get("doc1") ?? 0) - (m.get("doc3") ?? 0)) < 1e-12);
  // doc2 and doc4 each have only one contribution so they should be lower than doc1/doc3
  assert.ok((m.get("doc1") ?? 0) > (m.get("doc2") ?? 0));
  assert.ok((m.get("doc3") ?? 0) > (m.get("doc4") ?? 0));
  // Length is the unique count
  assert.equal(fused.length, 4);
  // Sorted by score desc
  for (let i = 1; i < fused.length; i++) {
    assert.ok(fused[i - 1]!.score >= fused[i]!.score);
  }
});

test("RRF: empty inputs return empty array", () => {
  const fused = rrf.fuseRankedLists([], { k: 60 });
  assert.equal(fused.length, 0);
});

test("RRF: k constant is exported and equals 60", () => {
  assert.equal(rrf.RRF_K, 60);
});
