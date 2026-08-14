import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-l1-scheduling-"));
process.env["DATA_DIR"] = TEST_DATA_DIR;
process.env["DISABLE_SQLITE_AUTO_BACKUP"] = "true";

const core = await import("../../../../src/memory/db/core.ts");
const l0 = await import("../../../../src/memory/l0.ts");
const { ownerFromApiKeyId } = await import("../../../../src/memory/integration/runtime.ts");
const scheduling = await import("../../../../src/memory/integration/l1Scheduling.ts");

function requireScheduling() {
  return scheduling;
}

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

test.afterEach(wipeDb);
test.after(() => {
  core.resetMemoryDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function insertTurn(scope: string, sessionId: string, index: number, timestamp: string): void {
  const owner = ownerFromApiKeyId(scope);
  l0.insertMessage({
    id: `l0-u-${index}`,
    owner,
    sessionKey: sessionId,
    sessionId,
    role: "user",
    content: `user ${index}`,
    source: "user",
    correlationId: `corr-${index}`,
    comboExecutionKey: null,
    isInternal: false,
    provider: "openai",
    model: "gpt-4o-mini",
    truncated: false,
    idempotencyKey: `l0-u-${index}`,
    timestamp,
  });
  l0.insertMessage({
    id: `l0-a-${index}`,
    owner,
    sessionKey: sessionId,
    sessionId,
    role: "assistant",
    content: `assistant ${index}`,
    source: "assistant",
    correlationId: `corr-${index}`,
    comboExecutionKey: null,
    isInternal: false,
    provider: "openai",
    model: "gpt-4o-mini",
    truncated: false,
    idempotencyKey: `l0-a-${index}`,
    timestamp,
  });
}

test("first conversation schedules an executable L1 task after the warm-up delay", () => {
  const module = requireScheduling();
  insertTurn("owner-a", "session-a", 1, "2026-08-13T10:00:00.000Z");

  const plan = module.planPendingL1Task({
    scope: "owner-a",
    sessionId: "session-a",
    correlationId: "corr-1",
    capturedAt: "2026-08-13T10:00:00.000Z",
    now: 1_000_000,
  });

  assert.ok(plan);
  assert.equal(plan.kind, "L1_extract");
  assert.equal(plan.scope, "owner-a");
  assert.equal(plan.notBefore, 1_001_000);
  assert.equal(plan.coalesceKey, "l1:session:session-a");
  assert.deepEqual(plan.payload.sourceMessageIds, ["l0-u-1", "l0-a-1"]);
  assert.equal(plan.payload.roundCount, 1);
  assert.equal(plan.coalesceNotBefore, "earliest");
});

test("after one completed run a single round resets to the 10 minute idle deadline", () => {
  const module = requireScheduling();
  insertTurn("owner-a", "session-a", 1, "2026-08-13T10:00:00.000Z");
  const first = module.planPendingL1Task({
    scope: "owner-a",
    sessionId: "session-a",
    correlationId: null,
    capturedAt: "2026-08-13T10:00:00.000Z",
    now: 1_000_000,
  });
  assert.ok(first);
  module.markL1TaskApplied({
    scope: "owner-a",
    payload: first.payload,
  });
  insertTurn("owner-a", "session-a", 2, "2026-08-13T10:01:00.000Z");

  core.resetMemoryDbInstance();
  const afterRestart = module.planPendingL1Task({
    scope: "owner-a",
    sessionId: "session-a",
    correlationId: null,
    capturedAt: "2026-08-13T10:01:00.000Z",
    now: 2_000_000,
  });

  assert.ok(afterRestart);
  assert.equal(afterRestart.notBefore, 2_600_000);
  assert.equal(afterRestart.coalesceNotBefore, "replace");
});

test("same-second cursor keeps unprocessed rows and excludes applied rows", () => {
  const module = requireScheduling();
  const sameTime = "2026-08-13T10:00:00.000Z";
  for (let index = 1; index <= 6; index++) {
    insertTurn("owner-a", "session-a", index, sameTime);
  }

  const first = module.planPendingL1Task({
    scope: "owner-a",
    sessionId: "session-a",
    correlationId: null,
    capturedAt: sameTime,
    now: 1_000_000,
  });
  assert.ok(first);
  assert.equal(first.payload.sourceMessageIds.length, 10);
  module.markL1TaskApplied({ scope: "owner-a", payload: first.payload });

  const residual = module.planPendingL1Task({
    scope: "owner-a",
    sessionId: "session-a",
    correlationId: null,
    capturedAt: sameTime,
    now: 1_001_000,
  });
  assert.ok(residual);
  assert.deepEqual(residual.payload.sourceMessageIds, ["l0-u-6", "l0-a-6"]);
  assert.equal(residual.payload.roundCount, 1);
});

test("marking the residual applied leaves no pending task after restart", () => {
  const module = requireScheduling();
  insertTurn("owner-a", "session-a", 1, "2026-08-13T10:00:00.000Z");
  const plan = module.planPendingL1Task({
    scope: "owner-a",
    sessionId: "session-a",
    correlationId: null,
    capturedAt: "2026-08-13T10:00:00.000Z",
    now: 1_000_000,
  });
  assert.ok(plan);
  module.markL1TaskApplied({ scope: "owner-a", payload: plan.payload });
  core.resetMemoryDbInstance();

  assert.equal(
    module.planPendingL1Task({
      scope: "owner-a",
      sessionId: "session-a",
      correlationId: null,
      capturedAt: "2026-08-13T10:00:00.000Z",
      now: 2_000_000,
    }),
    null
  );
});
