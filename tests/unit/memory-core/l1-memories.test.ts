/**
 * tests/unit/memory-core/l1-memories.test.ts
 *
 * L1 (memories) tests — 7 types, priority, scene, versioned update, soft delete, owner-scoped FTS.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-mem-l1-"));
process.env["DATA_DIR"] = TEST_DATA_DIR;
process.env["DISABLE_SQLITE_AUTO_BACKUP"] = "true";

const coreDb = await import("../../../src/memory/db/core.ts");
const { getMemoryDbInstance, resetMemoryDbInstance, getMemoryDbFilePath } = coreDb;
const l1 = await import("../../../src/memory/l1.ts");

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

function aMem(
  overrides: Partial<Parameters<typeof l1.createMemory>[0]> = {}
): Parameters<typeof l1.createMemory>[0] {
  return {
    owner: OWNER_A,
    type: "episodic",
    content: "the user prefers concise replies",
    priority: 50,
    sceneName: "default",
    sourceMessageIds: ["m1", "m2"],
    metadata: { tag: "v1" },
    editedByUser: false,
    lastModifiedBy: "user",
    ...overrides,
  };
}

test("createMemory assigns a stable memory_id", () => {
  wipeDb();
  const m = l1.createMemory(aMem());
  assert.ok(m.id && m.id.length > 0, "id must be set");
});

test("supports all 7 memory types", () => {
  wipeDb();
  for (const t of [
    "persona",
    "episodic",
    "instruction",
    "work_fact",
    "work_task",
    "work_method",
    "work_artifact",
  ] as const) {
    const m = l1.createMemory(aMem({ type: t, content: `content for ${t}` }));
    assert.equal(m.type, t);
    assert.ok(m.id);
  }
});

test("type is constrained to the 7-type set", () => {
  wipeDb();
  assert.throws(() => l1.createMemory(aMem({ type: "factual" as unknown as "episodic" })), /type/i);
});

test("priority range 0..100 enforced", () => {
  wipeDb();
  assert.throws(() => l1.createMemory(aMem({ priority: -1 })), /priority/i);
  assert.throws(() => l1.createMemory(aMem({ priority: 101 })), /priority/i);
  const ok = l1.createMemory(aMem({ priority: 100 }));
  assert.equal(ok.priority, 100);
});

test("updateMemory creates a new version row — old version still accessible", () => {
  wipeDb();
  const v1 = l1.createMemory(aMem({ content: "version 1" }));
  const v2 = l1.updateMemory(v1.id, OWNER_A, { content: "version 2", lastModifiedBy: "pipeline" });
  assert.equal(v2.id, v1.id, "stable memory_id is preserved");
  assert.equal(v2.version, 2);
  assert.equal(v2.content, "version 2");
  assert.equal(v2.lastModifiedBy, "pipeline");
  // History endpoint returns all versions
  const history = l1.getMemoryHistory(v1.id, OWNER_A);
  assert.equal(history.length, 2);
  assert.deepEqual(
    history.map((h) => h.version),
    [1, 2]
  );
});

test("owner isolation — B cannot read/update A's memories", () => {
  wipeDb();
  const a = l1.createMemory(aMem({ content: "A's memory" }));
  // B reading
  const fromB = l1.getMemoryById(a.id, OWNER_B);
  assert.equal(fromB, null, "B must not see A's memory by id");
  // B listing
  const listFromB = l1.listMemories({ owner: OWNER_B });
  assert.equal(listFromB.length, 0);
  // B updating
  assert.throws(() => l1.updateMemory(a.id, OWNER_B, { content: "tampered" }), /owner/i);
});

test("FTS search 'concise' returns the matching memory", () => {
  wipeDb();
  l1.createMemory(aMem({ content: "user prefers concise answers" }));
  l1.createMemory(aMem({ content: "user prefers verbose answers" }));
  const hits = l1.searchMemories({ owner: OWNER_A, query: "concise" });
  assert.equal(hits.length, 1);
  assert.ok(hits[0]!.content.includes("concise"));
});

test("soft delete sets tombstone; list excludes tombstoned by default; restore clears tombstone", () => {
  wipeDb();
  const m = l1.createMemory(aMem({ content: "will be soft-deleted" }));
  l1.softDeleteMemory(m.id, OWNER_A);
  const listed = l1.listMemories({ owner: OWNER_A });
  assert.equal(listed.length, 0, "soft-deleted should not appear in default list");
  const incl = l1.listMemories({ owner: OWNER_A, includeDeleted: true });
  assert.equal(incl.length, 1);
  assert.ok(incl[0]!.deletedAt !== null);
  assert.ok(incl[0]!.tombstone === true);

  l1.restoreMemory(m.id, OWNER_A);
  const restored = l1.listMemories({ owner: OWNER_A });
  assert.equal(restored.length, 1);
  assert.equal(restored[0]!.deletedAt, null);
});

test("editedByUser and lastModifiedBy persist correctly across updates", () => {
  wipeDb();
  const v1 = l1.createMemory(aMem({ editedByUser: false, lastModifiedBy: "user" }));
  assert.equal(v1.editedByUser, false);
  assert.equal(v1.lastModifiedBy, "user");
  const v2 = l1.updateMemory(v1.id, OWNER_A, { editedByUser: true, lastModifiedBy: "pipeline" });
  assert.equal(v2.editedByUser, true);
  assert.equal(v2.lastModifiedBy, "pipeline");
});

test("permanentDeleteMemory removes the row entirely", () => {
  wipeDb();
  const m = l1.createMemory(aMem({ content: "to be wiped" }));
  l1.permanentDeleteMemory(m.id, OWNER_A);
  const incl = l1.listMemories({ owner: OWNER_A, includeDeleted: true });
  assert.equal(incl.length, 0);
  const got = l1.getMemoryById(m.id, OWNER_A);
  assert.equal(got, null);
});

test("sourceMessageIds and metadata persist (stored as JSON)", () => {
  wipeDb();
  const m = l1.createMemory(
    aMem({
      sourceMessageIds: ["m1", "m2", "m3"],
      metadata: { foo: "bar", n: 7 },
    })
  );
  assert.deepEqual(m.sourceMessageIds, ["m1", "m2", "m3"]);
  assert.deepEqual(m.metadata, { foo: "bar", n: 7 });
  const got = l1.getMemoryById(m.id, OWNER_A);
  assert.ok(got);
  assert.deepEqual(got!.sourceMessageIds, ["m1", "m2", "m3"]);
  assert.deepEqual(got!.metadata, { foo: "bar", n: 7 });
});

test("type filter narrows list", () => {
  wipeDb();
  l1.createMemory(aMem({ type: "persona", content: "p1" }));
  l1.createMemory(aMem({ type: "instruction", content: "i1" }));
  const persona = l1.listMemories({ owner: OWNER_A, type: "persona" });
  assert.equal(persona.length, 1);
  assert.equal(persona[0]!.type, "persona");
});

test("sceneName filter narrows list", () => {
  wipeDb();
  l1.createMemory(aMem({ sceneName: "code", content: "c1" }));
  l1.createMemory(aMem({ sceneName: "chat", content: "c2" }));
  const code = l1.listMemories({ owner: OWNER_A, sceneName: "code" });
  assert.equal(code.length, 1);
  assert.equal(code[0]!.sceneName, "code");
});
