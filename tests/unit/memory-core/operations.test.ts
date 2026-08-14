import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-mem-ops-"));
process.env["DATA_DIR"] = TEST_DATA_DIR;
process.env["DISABLE_SQLITE_AUTO_BACKUP"] = "true";

const coreDb = await import("../../../src/memory/db/core.ts");
const { resetMemoryDbInstance, getMemoryDbFilePath } = coreDb;
const ops = await import("../../../src/memory/operations.ts");

test.after(() => {
  resetMemoryDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function wipeDb(): void {
  resetMemoryDbInstance();
  const filePath = getMemoryDbFilePath();
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

test("getSetting returns null for an unset key", () => {
  wipeDb();
  assert.equal(ops.getSetting("missing-key"), null);
});

test("upsertSetting stores and versions values", () => {
  wipeDb();
  const first = ops.upsertSetting("foo", "v1");
  assert.equal(first.version, 1);
  assert.equal(first.value, "v1");

  const second = ops.upsertSetting("foo", "v2");
  assert.equal(second.version, 2);
  assert.equal(second.value, "v2");
});

test("softDeleteSetting hides the setting unless deleted rows are requested", () => {
  wipeDb();
  ops.upsertSetting("foo", "bar");
  ops.softDeleteSetting("foo");
  assert.equal(ops.getSetting("foo"), null);
  assert.ok(ops.getSetting("foo", { includeDeleted: true })?.deletedAt);
});

test("upsertEmbeddingMeta stores signature, dimension, and source", () => {
  wipeDb();
  ops.upsertEmbeddingMeta({
    signature: "openai:text-embedding-3-small:1536",
    activeDim: 1536,
    source: "remote",
  });
  const metadata = ops.getEmbeddingMeta();
  assert.equal(metadata?.signature, "openai:text-embedding-3-small:1536");
  assert.equal(metadata?.activeDim, 1536);
  assert.equal(metadata?.source, "remote");
  assert.ok(metadata?.updatedAt);
});

test("upsertEmbeddingMeta replaces the active signature", () => {
  wipeDb();
  ops.upsertEmbeddingMeta({ signature: "s1", activeDim: 4, source: "remote" });
  ops.upsertEmbeddingMeta({ signature: "s2", activeDim: 8, source: "remote" });
  const metadata = ops.getEmbeddingMeta();
  assert.equal(metadata?.signature, "s2");
  assert.equal(metadata?.activeDim, 8);
});
