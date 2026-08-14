import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-memory-pipeline-"));
process.env["DATA_DIR"] = TEST_DATA_DIR;
process.env["DISABLE_SQLITE_AUTO_BACKUP"] = "true";

// Dynamic imports must happen after DATA_DIR is isolated for this test process.
const dbCore = await import("../../src/lib/db/core.ts");
const memoryCore = await import("../../src/memory/db/core.ts");
const { getMessageById, listMessages } = await import("../../src/memory/l0.ts");
const { createMemory } = await import("../../src/memory/l1.ts");
const { createScene } = await import("../../src/memory/l2.ts");
const { upsertPersona } = await import("../../src/memory/l3.ts");
const { buildL0CaptureRecords, scheduleL0Capture } =
  await import("../../src/memory/integration/l0Capture.ts");
type L0MessageRecord = import("../../src/memory/integration/l0Capture.ts").L0MessageRecord;
const { getProductionL0MessageStore, ownerFromApiKeyId } =
  await import("../../src/memory/integration/runtime.ts");
const { recallLayeredContext, resetRecallProviderForTests } =
  await import("../../src/memory/recall/facade.ts");
const { renderLayeredInjection, resolveTotalBudget, TRUNCATION_SUFFIX } =
  await import("../../src/memory/integration/injectionTransformer.ts");

type Owner = ReturnType<typeof ownerFromApiKeyId>;

function wipeMemoryDb(): void {
  memoryCore.resetMemoryDbInstance();
  const filePath = memoryCore.getMemoryDbFilePath();
  if (filePath === ":memory:") return;
  for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`, `${filePath}-journal`]) {
    try {
      fs.unlinkSync(candidate);
    } catch {
      // The database or sidecar may not exist yet.
    }
  }
}

async function captureTurn(input: {
  ownerId: string;
  sessionId: string;
  correlationId: string;
  user: string;
  assistant: string;
}): Promise<L0MessageRecord[]> {
  const records = buildL0CaptureRecords({
    ownerId: input.ownerId,
    sessionId: input.sessionId,
    correlationId: input.correlationId,
    comboExecutionKey: null,
    requestBody: { messages: [{ role: "user", content: input.user }] },
    responseBody: { choices: [{ message: { content: input.assistant } }] },
    source: "chat",
    provider: "openai",
    model: "gpt-4o-mini",
  });
  assert.equal(records.length, 2, "a visible turn should produce user and assistant records");

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for scheduled L0 capture")),
      2_000
    );
    scheduleL0Capture(records, {
      store: getProductionL0MessageStore(),
      enqueueL1: {
        enqueueL1Task() {
          clearTimeout(timeout);
          resolve();
        },
      },
    });
  });

  return records;
}

function createWorkFact(owner: Owner, content: string, sourceMessageIds: string[] = []): void {
  createMemory({
    owner,
    type: "work_fact",
    priority: 80,
    sceneName: "project",
    sourceMessageIds,
    metadata: { tags: ["typescript", "backend"] },
    content,
    lastModifiedBy: "pipeline",
    editedByUser: false,
  });
}

function seedStableLayers(owner: Owner): void {
  createScene({
    owner,
    sceneName: "project",
    groupKey: "omniroute",
    summary: "Navigation for the active TypeScript project.",
    heat: 0.9,
    content: "The active work concerns the OmniRoute backend.",
    lastModifiedBy: "pipeline",
    editedByUser: false,
  });
  upsertPersona({
    owner,
    content: "Prefer concise answers with concrete TypeScript examples.",
    promptMode: "code",
    lastModifiedBy: "pipeline",
    editedByUser: false,
  });
}

test.beforeEach(() => {
  wipeMemoryDb();
  resetRecallProviderForTests();
});

test.afterEach(() => {
  resetRecallProviderForTests();
  wipeMemoryDb();
});

test.after(() => {
  resetRecallProviderForTests();
  memoryCore.resetMemoryDbInstance();
  dbCore.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("scheduled L0 capture is idempotent and isolated by owner and session", async () => {
  const ownerA = ownerFromApiKeyId("owner-a");
  const ownerB = ownerFromApiKeyId("owner-b");
  const sessionATurn = {
    ownerId: "owner-a",
    sessionId: "session-a",
    correlationId: "correlation-a",
    user: "Remember the alpha session request.",
    assistant: "Alpha session response.",
  };

  const firstRecords = await captureTurn(sessionATurn);
  await captureTurn(sessionATurn);
  await captureTurn({
    ownerId: "owner-a",
    sessionId: "session-b",
    correlationId: "correlation-b",
    user: "Remember the beta session request.",
    assistant: "Beta session response.",
  });
  await captureTurn({
    ownerId: "owner-b",
    sessionId: "session-a",
    correlationId: "correlation-owner-b",
    user: "Owner B private request.",
    assistant: "Owner B private response.",
  });

  const ownerASessionA = listMessages({ owner: ownerA, sessionId: "session-a" });
  const ownerASessionB = listMessages({ owner: ownerA, sessionId: "session-b" });
  const ownerBSessionA = listMessages({ owner: ownerB, sessionId: "session-a" });

  assert.equal(ownerASessionA.length, 2, "replaying the same capture must not duplicate L0");
  assert.deepEqual(
    ownerASessionA.map((message) => [message.role, message.content]),
    [
      ["user", "Remember the alpha session request."],
      ["assistant", "Alpha session response."],
    ]
  );
  assert.equal(ownerASessionB.length, 2);
  assert.ok(ownerASessionB.every((message) => /beta/i.test(message.content)));
  assert.equal(ownerBSessionA.length, 2);
  assert.ok(ownerBSessionA.every((message) => /Owner B private/i.test(message.content)));
  assert.equal(listMessages({ owner: ownerA }).length, 4);
  assert.equal(
    getMessageById(firstRecords[0]!.id, ownerB),
    null,
    "an L0 id must not cross owner partitions"
  );
});

test("production recall returns owner-scoped L1/L2/L3 and never exposes captured L0", async () => {
  const ownerA = ownerFromApiKeyId("owner-a");
  const ownerB = ownerFromApiKeyId("owner-b");
  const raw = await captureTurn({
    ownerId: "owner-a",
    sessionId: "session-recall",
    correlationId: "correlation-recall",
    user: "RAW L0 request must stay out of recall.",
    assistant: "RAW L0 response must stay out of recall.",
  });

  createWorkFact(
    ownerA,
    "TypeScript backend is the preferred stack for this owner.",
    raw.map((record) => record.id)
  );
  createWorkFact(ownerA, "Gardening is an unrelated weekend activity.");
  createWorkFact(ownerB, "OWNER B SECRET TypeScript backend details.");
  seedStableLayers(ownerA);
  seedStableLayers(ownerB);

  const recalled = await recallLayeredContext(
    {
      ownerId: "owner-a",
      sessionId: "session-recall",
      query: "TypeScript backend",
    },
    { timeoutMs: 1_000 }
  );

  assert.equal(recalled.l1Status, "ok");
  assert.equal(recalled.l2Status, "ok");
  assert.equal(recalled.l3Status, "ok");
  assert.equal(recalled.layers.l1.length, 1);
  assert.match(recalled.layers.l1[0]!.content, /preferred stack/);
  assert.deepEqual(
    recalled.layers.l2.map((item) => item.title),
    ["project"]
  );
  assert.match(recalled.layers.l3[0]!.content, /concise answers/);

  const serialized = JSON.stringify(recalled.layers);
  assert.doesNotMatch(serialized, /RAW L0/);
  assert.doesNotMatch(serialized, /OWNER B SECRET/);
  assert.equal(Object.hasOwn(recalled.layers, "l0"), false);
});

test("recalled layers inject within token-derived budgets and preserve the user prompt", async () => {
  const ownerA = ownerFromApiKeyId("owner-a");
  const ownerB = ownerFromApiKeyId("owner-b");
  await captureTurn({
    ownerId: "owner-a",
    sessionId: "session-budget",
    correlationId: "correlation-budget",
    user: "RAW L0 budget request must not be injected.",
    assistant: "RAW L0 budget response must not be injected.",
  });
  createWorkFact(
    ownerA,
    `Newest preference should fit first. ${"Detailed preference context. ".repeat(20)}`
  );
  createWorkFact(ownerB, "OWNER B SECRET must never enter owner A's prompt.");
  seedStableLayers(ownerA);

  const recalled = await recallLayeredContext(
    { ownerId: "owner-a", sessionId: "session-budget", query: "" },
    { timeoutMs: 1_000 }
  );
  const totalCharBudget = resolveTotalBudget(60, 8_000);
  assert.equal(totalCharBudget, 240, "60 tokens should resolve to a 240-character budget");

  const rendered = renderLayeredInjection(
    {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "What should I prioritize?" }],
    },
    recalled.layers,
    {
      l3CharBudget: 120,
      l2CharBudget: 120,
      l1CharBudget: 150,
      totalCharBudget,
    },
    { provider: "openai", isCachingProvider: true, maxTokens: 60 }
  );

  const messages = rendered.body.messages as Array<{ role: string; content: string }>;
  assert.equal(messages.length, 3);
  assert.equal(messages[0]!.role, "system");
  assert.ok(messages[0]!.content.length <= totalCharBudget);
  assert.equal(messages[1]!.role, "user");
  assert.match(messages[1]!.content, /<relevant-memories>/);
  assert.match(messages[1]!.content, /Newest preference should fit first/);
  assert.ok(messages[1]!.content.endsWith(TRUNCATION_SUFFIX));
  assert.ok(messages[1]!.content.length <= 150);
  assert.deepEqual(messages[2], { role: "user", content: "What should I prioritize?" });
  assert.equal(rendered.l1Placement, "pre-last-user");
  assert.equal(rendered.injectedL1Count, 1);
  assert.equal(rendered.injectedL2Count, 1);
  assert.equal(rendered.injectedL3Count, 1);

  const serialized = JSON.stringify(rendered.body);
  assert.doesNotMatch(serialized, /RAW L0 budget/);
  assert.doesNotMatch(serialized, /OWNER B SECRET/);
});
