/**
 * tests/unit/memory-core/l2-scenes.test.ts
 *
 * L2 (scenes) tests — one scene per scene_id, max 15 active, CRUD + derived navigation,
 * UPDATE>MERGE>CREATE-compatible primitives.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-mem-l2-"));
process.env["DATA_DIR"] = TEST_DATA_DIR;
process.env["DISABLE_SQLITE_AUTO_BACKUP"] = "true";

const coreDb = await import("../../../src/memory/db/core.ts");
const { resetMemoryDbInstance, getMemoryDbFilePath } = coreDb;
const l2 = await import("../../../src/memory/l2.ts");

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

test("createScene assigns a stable scene_id", () => {
  wipeDb();
  const s = l2.createScene({
    owner: OWNER_A,
    sceneName: "code",
    summary: "code-focused context",
    content: "full content",
    heat: 0.5,
    lastModifiedBy: "user",
    editedByUser: false,
  });
  assert.ok(s.id);
  assert.equal(s.sceneName, "code");
});

test("max 15 active scenes per owner — 16th createScene throws", () => {
  wipeDb();
  for (let i = 0; i < 15; i++) {
    l2.createScene({
      owner: OWNER_A,
      sceneName: `scene-${i}`,
      summary: `s${i}`,
      content: "x",
      heat: 0.1,
      lastModifiedBy: "user",
      editedByUser: false,
    });
  }
  assert.throws(
    () =>
      l2.createScene({
        owner: OWNER_A,
        sceneName: "scene-overflow",
        summary: "x",
        content: "x",
        heat: 0.1,
        lastModifiedBy: "user",
        editedByUser: false,
      }),
    /max|15|active/i
  );
});

test("upsertScene behaves as CREATE when sceneName+groupKey is new", () => {
  wipeDb();
  const r = l2.upsertScene({
    owner: OWNER_A,
    sceneName: "code",
    groupKey: null,
    summary: "v1",
    content: "v1 content",
    heat: 0.1,
    lastModifiedBy: "user",
    editedByUser: false,
  });
  assert.equal(r.created, true);
});

test("upsertScene behaves as UPDATE when sceneName+groupKey matches an existing row", () => {
  wipeDb();
  l2.createScene({
    owner: OWNER_A,
    sceneName: "code",
    summary: "v1",
    content: "v1",
    heat: 0.1,
    lastModifiedBy: "user",
    editedByUser: false,
  });
  const r = l2.upsertScene({
    owner: OWNER_A,
    sceneName: "code",
    groupKey: null,
    summary: "v2",
    content: "v2",
    heat: 0.5,
    lastModifiedBy: "pipeline",
    editedByUser: true,
  });
  assert.equal(r.created, false);
  assert.equal(r.scene.summary, "v2");
  assert.equal(r.scene.heat, 0.5);
});

test("upsertScene behaves as MERGE — heat is averaged when caller passes mergeHeat:true", () => {
  wipeDb();
  const created = l2.createScene({
    owner: OWNER_A,
    sceneName: "code",
    summary: "v1",
    content: "v1",
    heat: 0.4,
    lastModifiedBy: "user",
    editedByUser: false,
  });
  const r = l2.upsertScene({
    owner: OWNER_A,
    sceneName: "code",
    groupKey: null,
    summary: "merged",
    content: "merged",
    heat: 0.8,
    mergeHeat: true,
    lastModifiedBy: "pipeline",
    editedByUser: false,
  });
  assert.equal(r.created, false);
  assert.ok(Math.abs(r.scene.heat - 0.6) < 1e-9, `merged heat should be 0.6, got ${r.scene.heat}`);
  assert.equal(created.id, r.scene.id);
});

test("listScenes returns only non-deleted scenes by default", () => {
  wipeDb();
  l2.createScene({
    owner: OWNER_A,
    sceneName: "a",
    summary: "a",
    content: "a",
    heat: 0.1,
    lastModifiedBy: "user",
    editedByUser: false,
  });
  const b = l2.createScene({
    owner: OWNER_A,
    sceneName: "b",
    summary: "b",
    content: "b",
    heat: 0.1,
    lastModifiedBy: "user",
    editedByUser: false,
  });
  l2.softDeleteScene(b.id, OWNER_A);
  const visible = l2.listScenes({ owner: OWNER_A });
  assert.equal(visible.length, 1);
  assert.equal(visible[0]!.sceneName, "a");
});

test("getSceneById requires matching owner", () => {
  wipeDb();
  const s = l2.createScene({
    owner: OWNER_A,
    sceneName: "x",
    summary: "x",
    content: "x",
    heat: 0.1,
    lastModifiedBy: "user",
    editedByUser: false,
  });
  const wrong = l2.getSceneById(s.id, { teamId: "team-2", userId: "x", agentId: "x" });
  assert.equal(wrong, null);
});

test("permanentDeleteScene removes the row entirely", () => {
  wipeDb();
  const s = l2.createScene({
    owner: OWNER_A,
    sceneName: "x",
    summary: "x",
    content: "x",
    heat: 0.1,
    lastModifiedBy: "user",
    editedByUser: false,
  });
  l2.permanentDeleteScene(s.id, OWNER_A);
  const incl = l2.listScenes({ owner: OWNER_A, includeDeleted: true });
  assert.equal(incl.length, 0);
});

test("delete -> permanent-delete frees the active-scene slot", () => {
  wipeDb();
  // fill to 15 with deletion freeing slots
  const ids: string[] = [];
  for (let i = 0; i < 15; i++) {
    const s = l2.createScene({
      owner: OWNER_A,
      sceneName: `s${i}`,
      summary: "x",
      content: "x",
      heat: 0.1,
      lastModifiedBy: "user",
      editedByUser: false,
    });
    ids.push(s.id);
  }
  l2.permanentDeleteScene(ids[0]!, OWNER_A);
  // Should now be able to add one more.
  const newScene = l2.createScene({
    owner: OWNER_A,
    sceneName: "free-slot",
    summary: "x",
    content: "x",
    heat: 0.1,
    lastModifiedBy: "user",
    editedByUser: false,
  });
  assert.ok(newScene.id);
});

test("nav: listScenesOrderedByHeat returns scenes sorted descending by heat", () => {
  wipeDb();
  l2.createScene({
    owner: OWNER_A,
    sceneName: "cold",
    summary: "x",
    content: "x",
    heat: 0.1,
    lastModifiedBy: "user",
    editedByUser: false,
  });
  l2.createScene({
    owner: OWNER_A,
    sceneName: "warm",
    summary: "x",
    content: "x",
    heat: 0.7,
    lastModifiedBy: "user",
    editedByUser: false,
  });
  l2.createScene({
    owner: OWNER_A,
    sceneName: "hot",
    summary: "x",
    content: "x",
    heat: 0.9,
    lastModifiedBy: "user",
    editedByUser: false,
  });
  const ordered = l2.listScenesOrderedByHeat({ owner: OWNER_A });
  assert.deepEqual(
    ordered.map((s) => s.sceneName),
    ["hot", "warm", "cold"]
  );
});
