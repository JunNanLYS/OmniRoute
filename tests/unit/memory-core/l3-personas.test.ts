/**
 * tests/unit/memory-core/l3-personas.test.ts
 *
 * L3 (personas) tests — one active row per owner; upsert/update/clear/restore/permanent delete.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-mem-l3-"));
process.env["DATA_DIR"] = TEST_DATA_DIR;
process.env["DISABLE_SQLITE_AUTO_BACKUP"] = "true";

const coreDb = await import("../../../src/memory/db/core.ts");
const { resetMemoryDbInstance, getMemoryDbFilePath } = coreDb;
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

function aPersona(
  overrides: Partial<Parameters<typeof l3.upsertPersona>[0]> = {}
): Parameters<typeof l3.upsertPersona>[0] {
  return {
    owner: OWNER_A,
    content: "Be concise and friendly",
    promptMode: "chat",
    lastModifiedBy: "user",
    editedByUser: false,
    ...overrides,
  };
}

test("upsertPersona sets a stable persona_id; second call updates in place", () => {
  wipeDb();
  const v1 = l3.upsertPersona(aPersona({ content: "v1" }));
  assert.ok(v1.personaId);
  assert.equal(v1.version, 1);
  const v2 = l3.upsertPersona(aPersona({ content: "v2", lastModifiedBy: "pipeline" }));
  assert.equal(v2.personaId, v1.personaId);
  assert.equal(v2.version, 2);
  assert.equal(v2.content, "v2");
});

test("only one active persona per owner — second owner gets a different persona_id", () => {
  wipeDb();
  const a = l3.upsertPersona(aPersona({ content: "A" }));
  const b = l3.upsertPersona(aPersona({ content: "B", owner: OWNER_B }));
  assert.notEqual(a.personaId, b.personaId);
});

test("promptMode is constrained to chat|code", () => {
  wipeDb();
  assert.throws(
    () => l3.upsertPersona(aPersona({ promptMode: "weird" as unknown as "chat" })),
    /promptMode/i
  );
});

test("clearPersona soft-deletes (sets deleted_at) but keeps row for restore", () => {
  wipeDb();
  const p = l3.upsertPersona(aPersona());
  l3.clearPersona(OWNER_A);
  const cleared = l3.getActivePersona(OWNER_A);
  assert.equal(cleared, null, "after clear, no active persona");
  // includeDeleted should still surface it
  const incl = l3.getActivePersona(OWNER_A, { includeDeleted: true });
  assert.ok(incl);
  assert.ok(incl!.deletedAt !== null);
  // persona_id is preserved
  assert.equal(incl!.personaId, p.personaId);
});

test("restorePersona clears deleted_at — it becomes active again", () => {
  wipeDb();
  l3.upsertPersona(aPersona());
  l3.clearPersona(OWNER_A);
  l3.restorePersona(OWNER_A);
  const restored = l3.getActivePersona(OWNER_A);
  assert.ok(restored);
  assert.equal(restored!.deletedAt, null);
});

test("permanentDeletePersona removes the row entirely", () => {
  wipeDb();
  l3.upsertPersona(aPersona());
  l3.permanentDeletePersona(OWNER_A);
  const incl = l3.getActivePersona(OWNER_A, { includeDeleted: true });
  assert.equal(incl, null);
});

test("upsertPersona after clear should restore-or-replace the active persona", () => {
  wipeDb();
  const p1 = l3.upsertPersona(aPersona({ content: "p1" }));
  l3.clearPersona(OWNER_A);
  const p2 = l3.upsertPersona(aPersona({ content: "p2" }));
  // After clear + upsert, the same persona_id is reused (singleton per owner)
  assert.equal(p2.personaId, p1.personaId);
  const active = l3.getActivePersona(OWNER_A);
  assert.ok(active);
  assert.equal(active!.content, "p2");
  assert.equal(active!.deletedAt, null);
});

test("editedByUser and lastModifiedBy persist across upserts", () => {
  wipeDb();
  l3.upsertPersona(aPersona({ editedByUser: false, lastModifiedBy: "user" }));
  const got = l3.getActivePersona(OWNER_A);
  assert.ok(got);
  assert.equal(got!.editedByUser, false);
  assert.equal(got!.lastModifiedBy, "user");
  l3.upsertPersona(aPersona({ editedByUser: true, lastModifiedBy: "pipeline", content: "v2" }));
  const updated = l3.getActivePersona(OWNER_A);
  assert.ok(updated);
  assert.equal(updated!.editedByUser, true);
  assert.equal(updated!.lastModifiedBy, "pipeline");
});
