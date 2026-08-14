import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-distillation-apply-"));
process.env["DATA_DIR"] = TEST_DATA_DIR;
process.env["DISABLE_SQLITE_AUTO_BACKUP"] = "true";

const core = await import("../../../../src/memory/db/core.ts");
const repository = await import("../../../../src/memory/db/repositories/distillation.ts");
const l0 = await import("../../../../src/memory/l0.ts");
const l1 = await import("../../../../src/memory/l1.ts");
const l2 = await import("../../../../src/memory/l2.ts");
const l3 = await import("../../../../src/memory/l3.ts");
const { ownerFromApiKeyId } = await import("../../../../src/memory/integration/runtime.ts");

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

async function complete(input: {
  kind: "L1_extract" | "L2_scene" | "L3_persona";
  scope: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
}) {
  const task = repository.enqueueDistillationTask({
    kind: input.kind,
    scope: input.scope,
    payload: input.payload,
    priority: 5,
    notBefore: 0,
  });
  const store = repository.createDistillationStore();
  const ownerId = `worker-${task.id}`;
  assert.equal(await store.markClaimed(task.id, task.version, ownerId, 60_000), true);
  await store.markRunning(task.id, ownerId);
  await store.completeTask(task, ownerId, {
    payload: input.result,
    fallbackEvidence: [],
  });
  return task;
}

function l1Result(content: string, sourceMessageIds: string[]) {
  return {
    scenes: [
      {
        sceneName: "project-a",
        messageIds: sourceMessageIds,
        memories: [
          {
            content,
            type: "work_fact",
            priority: 80,
            sourceMessageIds,
            metadata: { tags: ["project"] },
          },
        ],
      },
    ],
  };
}

test("L1 completion queues residual canonical L0 backlog before committing success", async () => {
  const scope = "owner-l1-backlog";
  const owner = ownerFromApiKeyId(scope);
  const timestamp = "2026-08-13T10:00:00.000Z";
  for (let index = 1; index <= 6; index++) {
    for (const role of ["user", "assistant"] as const) {
      const id = `l0-${role}-${index}`;
      l0.insertMessage({
        id,
        owner,
        sessionKey: "session-a",
        sessionId: "session-a",
        role,
        content: `${role} ${index}`,
        source: role,
        correlationId: `corr-${index}`,
        comboExecutionKey: null,
        isInternal: false,
        provider: "openai",
        model: "gpt-4o-mini",
        truncated: false,
        idempotencyKey: id,
        timestamp,
      });
    }
  }
  const { planPendingL1Task } = await import("../../../../src/memory/integration/l1Scheduling.ts");
  const plan = planPendingL1Task({
    scope,
    sessionId: "session-a",
    correlationId: "corr-5",
    capturedAt: timestamp,
    now: 1_000_000,
  });
  assert.ok(plan);
  const task = repository.enqueueDistillationTask(plan);
  const store = repository.createDistillationStore();
  assert.equal(await store.markClaimed(task.id, task.version, "worker-a", 60_000), true);
  await store.markRunning(task.id, "worker-a");
  await store.completeTask(task, "worker-a", {
    payload: l1Result("Backlog fact", plan.payload.sourceMessageIds),
    fallbackEvidence: [],
  });

  const queued = core
    .getMemoryDbInstance()
    .prepare(
      `SELECT payload_json FROM task_queue
       WHERE scope = ? AND kind = 'L1_extract' AND status = 'queued'`
    )
    .all(scope) as Array<{ payload_json: string }>;
  assert.equal(queued.length, 1);
  const residual = JSON.parse(queued[0]!.payload_json) as { sourceMessageIds: string[] };
  assert.deepEqual(residual.sourceMessageIds, ["l0-user-6", "l0-assistant-6"]);
});

test("L1 completion writes canonical typed memories with source lineage", async () => {
  const scope = "owner-l1";
  await complete({
    kind: "L1_extract",
    scope,
    payload: {
      sessionId: "session-a",
      sourceMessageIds: ["l0-1", "l0-2"],
      conversation: "user: use TypeScript\nassistant: acknowledged",
    },
    result: l1Result("The project uses TypeScript", ["l0-1", "l0-2"]),
  });

  const memories = l1.listMemories({ owner: ownerFromApiKeyId(scope) });
  assert.equal(memories.length, 1);
  assert.equal(memories[0]?.type, "work_fact");
  assert.equal(memories[0]?.sceneName, "project-a");
  assert.equal(memories[0]?.priority, 80);
  assert.deepEqual(memories[0]?.sourceMessageIds, ["l0-1", "l0-2"]);
  assert.equal(memories[0]?.lastModifiedBy, "pipeline");
  assert.equal(memories[0]?.metadata.sessionId, "session-a");
});

test("L1 exact duplicates merge lineage instead of creating another memory", async () => {
  const scope = "owner-l1-dedupe";
  await complete({
    kind: "L1_extract",
    scope,
    payload: { sourceMessageIds: ["l0-1"], conversation: "first" },
    result: l1Result("Prefers strict TypeScript", ["l0-1"]),
  });
  await complete({
    kind: "L1_extract",
    scope,
    payload: { sourceMessageIds: ["l0-2"], conversation: "second" },
    result: l1Result("Prefers strict TypeScript", ["l0-2"]),
  });

  const memories = l1.listMemories({ owner: ownerFromApiKeyId(scope) });
  assert.equal(memories.length, 1);
  assert.deepEqual(memories[0]?.sourceMessageIds, ["l0-1", "l0-2"]);
  assert.equal(memories[0]?.version, 2);
});

test("L1 pipeline replay never overwrites a user-edited exact match", async () => {
  const scope = "owner-l1-edited";
  const owner = ownerFromApiKeyId(scope);
  await complete({
    kind: "L1_extract",
    scope,
    payload: { sourceMessageIds: ["l0-1"], conversation: "first" },
    result: l1Result("Prefers dark mode", ["l0-1"]),
  });
  const [created] = l1.listMemories({ owner });
  assert.ok(created);
  l1.updateMemory(
    created.id,
    owner,
    {
      content: "Prefers light mode for accessibility",
      lastModifiedBy: "user",
      editedByUser: true,
    },
    created.version
  );

  await complete({
    kind: "L1_extract",
    scope,
    payload: { sourceMessageIds: ["l0-2"], conversation: "replay" },
    result: l1Result("Prefers dark mode", ["l0-2"]),
  });

  const memories = l1.listMemories({ owner });
  assert.equal(memories.length, 1);
  assert.equal(memories[0]?.content, "Prefers light mode for accessibility");
  assert.equal(memories[0]?.editedByUser, true);
});

test("L1 completion coalesces a delayed executable L2 scene task", async () => {
  const scope = "owner-l2-schedule";
  await complete({
    kind: "L1_extract",
    scope,
    payload: { sessionId: "session-a", sourceMessageIds: ["l0-1"], conversation: "first" },
    result: l1Result("Project fact one", ["l0-1"]),
  });
  await complete({
    kind: "L1_extract",
    scope,
    payload: { sessionId: "session-a", sourceMessageIds: ["l0-2"], conversation: "second" },
    result: l1Result("Project fact two", ["l0-2"]),
  });

  const rows = core
    .getMemoryDbInstance()
    .prepare(
      `SELECT payload_json, not_before FROM task_queue
       WHERE scope = ? AND kind = 'L2_scene' AND status = 'queued'`
    )
    .all(scope) as Array<{ payload_json: string; not_before: number }>;
  assert.equal(rows.length, 1);
  const payload = JSON.parse(rows[0]!.payload_json) as {
    conversation: string;
    sceneName: string;
    sourceMemoryIds: string[];
  };
  assert.match(payload.conversation, /Project fact one/);
  assert.match(payload.conversation, /Project fact two/);
  assert.equal(payload.sceneName, "project-a");
  assert.equal(payload.sourceMemoryIds.length, 2);
  assert.ok(rows[0]!.not_before > Date.now());
});

test("L2 completion writes a bounded canonical scene and queues first-scene L3", async () => {
  const scope = "owner-l2";
  await complete({
    kind: "L2_scene",
    scope,
    payload: {
      sceneName: "project-a",
      groupKey: "session-a",
      conversation: "Project details",
      sourceMemoryIds: ["l1-1"],
    },
    result: {
      summary: "Project A uses TypeScript",
      tags: ["typescript", "backend"],
      heat: 0.8,
      content: "Reusable project context",
    },
  });

  const scenes = l2.listScenes({ owner: ownerFromApiKeyId(scope) });
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0]?.sceneName, "project-a");
  assert.equal(scenes[0]?.groupKey, "session-a");
  assert.equal(scenes[0]?.summary, "Project A uses TypeScript");
  assert.equal(scenes[0]?.heat, 0.8);
  assert.equal(scenes[0]?.content, "Reusable project context");

  const queued = core
    .getMemoryDbInstance()
    .prepare(
      `SELECT payload_json FROM task_queue
       WHERE scope = ? AND kind = 'L3_persona' AND status = 'queued'`
    )
    .all(scope) as Array<{ payload_json: string }>;
  assert.equal(queued.length, 1);
  const payload = JSON.parse(queued[0]!.payload_json) as { samples: string[] };
  assert.match(payload.samples[0] ?? "", /Project A uses TypeScript/);
});

test("automatic L2 refresh does not overwrite a user-edited scene", async () => {
  const scope = "owner-l2-edited";
  const owner = ownerFromApiKeyId(scope);
  await complete({
    kind: "L2_scene",
    scope,
    payload: { sceneName: "project-a", groupKey: null, conversation: "initial" },
    result: { summary: "Initial", tags: [], heat: 0.5, content: "Initial content" },
  });
  const [scene] = l2.listScenes({ owner });
  assert.ok(scene);
  l2.updateScene(
    scene.id,
    owner,
    { summary: "User summary", content: "User content" },
    scene.version
  );

  await complete({
    kind: "L2_scene",
    scope,
    payload: { sceneName: "project-a", groupKey: null, conversation: "automatic refresh" },
    result: { summary: "Pipeline summary", tags: [], heat: 0.9, content: "Pipeline content" },
  });

  const [after] = l2.listScenes({ owner });
  assert.equal(after?.summary, "User summary");
  assert.equal(after?.content, "User content");
  assert.equal(after?.editedByUser, true);
});

test("manual L2 regeneration honors its baseline version when a user edits during the run", async () => {
  const scope = "owner-l2-cas";
  const owner = ownerFromApiKeyId(scope);
  const scene = l2.createScene({
    owner,
    sceneName: "project-a",
    groupKey: null,
    summary: "Before",
    heat: 0.5,
    content: "Before content",
    lastModifiedBy: "user",
    editedByUser: true,
  });
  l2.updateScene(
    scene.id,
    owner,
    { summary: "Edited while model ran", content: "User wins" },
    scene.version
  );

  await complete({
    kind: "L2_scene",
    scope,
    payload: {
      sceneId: scene.id,
      sceneName: "project-a",
      groupKey: null,
      conversation: "regenerate",
      baselineVersion: scene.version,
      allowUserOverwrite: true,
    },
    result: { summary: "Model output", tags: [], heat: 0.9, content: "Model replacement" },
  });

  const after = l2.getSceneById(scene.id, owner);
  assert.equal(after?.summary, "Edited while model ran");
  assert.equal(after?.content, "User wins");
});

test("automatic L1 application does not resurrect a user-deleted pipeline memory", async () => {
  const scope = "owner-l1-delete";
  const owner = ownerFromApiKeyId(scope);
  await complete({
    kind: "L1_extract",
    scope,
    payload: { sourceMessageIds: ["l0-1"], conversation: "first" },
    result: l1Result("Remembered preference", ["l0-1"]),
  });
  const [memory] = l1.listMemories({ owner });
  assert.ok(memory);
  l1.softDeleteMemory(memory.id, owner);

  await complete({
    kind: "L1_extract",
    scope,
    payload: { sourceMessageIds: ["l0-2"], conversation: "repeat" },
    result: l1Result("Remembered preference", ["l0-2"]),
  });

  assert.equal(l1.listMemories({ owner }).length, 0);
  const deleted = l1.listMemories({ owner, includeDeleted: true });
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0]?.editedByUser, true);
});

test("L2 capacity evicts only the coldest pipeline scene and remains bounded", async () => {
  const scope = "owner-l2-cap";
  const owner = ownerFromApiKeyId(scope);
  for (let index = 0; index < 15; index++) {
    l2.createScene({
      owner,
      sceneName: `scene-${index}`,
      groupKey: null,
      summary: `Summary ${index}`,
      heat: index / 20,
      content: `Content ${index}`,
      lastModifiedBy: "pipeline",
      editedByUser: false,
    });
  }

  await complete({
    kind: "L2_scene",
    scope,
    payload: { sceneName: "hot-new-scene", groupKey: null, conversation: "new" },
    result: { summary: "Hot", tags: [], heat: 1, content: "Hot content" },
  });

  const active = l2.listScenes({ owner });
  assert.equal(active.length, 15);
  assert.equal(
    active.some((scene) => scene.sceneName === "hot-new-scene"),
    true
  );
  assert.equal(
    active.some((scene) => scene.sceneName === "scene-0"),
    false
  );
});

test("L3 expected-absent baseline does not overwrite a persona created during the run", async () => {
  const scope = "owner-l3-null-cas";
  const owner = ownerFromApiKeyId(scope);
  l3.upsertPersona({
    owner,
    content: "Created while model ran",
    promptMode: "chat",
    lastModifiedBy: "user",
    editedByUser: true,
  });

  await complete({
    kind: "L3_persona",
    scope,
    payload: {
      samples: ["scene"],
      promptMode: "chat",
      baselineVersion: null,
      allowUserOverwrite: true,
    },
    result: { content: "Stale model output", promptMode: "chat" },
  });

  assert.equal(l3.getActivePersona(owner)?.content, "Created while model ran");
});

test("automatic L2 application does not resurrect a user-deleted scene", async () => {
  const scope = "owner-l2-delete";
  const owner = ownerFromApiKeyId(scope);
  const scene = l2.createScene({
    owner,
    sceneName: "project-a",
    groupKey: null,
    summary: "Before",
    heat: 0.5,
    content: "Before content",
    lastModifiedBy: "pipeline",
    editedByUser: false,
  });
  l2.softDeleteScene(scene.id, owner);

  await complete({
    kind: "L2_scene",
    scope,
    payload: { sceneName: "project-a", groupKey: null, conversation: "repeat" },
    result: { summary: "Model output", tags: [], heat: 0.8, content: "Replacement" },
  });

  assert.equal(l2.listScenes({ owner }).length, 0);
  const deleted = l2.listScenes({ owner, includeDeleted: true });
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0]?.editedByUser, true);
});

test("L3 completion does not revive a persona deleted while the model runs", async () => {
  const scope = "owner-l3-delete";
  const owner = ownerFromApiKeyId(scope);
  const persona = l3.upsertPersona({
    owner,
    content: "Before",
    promptMode: "chat",
    lastModifiedBy: "pipeline",
    editedByUser: false,
  });
  l3.clearPersona(owner);

  await complete({
    kind: "L3_persona",
    scope,
    payload: {
      samples: ["scene"],
      promptMode: "chat",
      baselineVersion: persona.version,
      allowUserOverwrite: true,
    },
    result: { content: "Stale replacement", promptMode: "chat" },
  });

  assert.equal(l3.getActivePersona(owner), null);
  const deleted = l3.getActivePersona(owner, { includeDeleted: true });
  assert.equal(deleted?.content, "Before");
  assert.equal(deleted?.editedByUser, true);
});

test("L3 completion writes the canonical singleton without overwriting later user edits", async () => {
  const scope = "owner-l3";
  const owner = ownerFromApiKeyId(scope);
  await complete({
    kind: "L3_persona",
    scope,
    payload: { samples: ["scene"], promptMode: "code", baselineVersion: null },
    result: { content: "# Team Operating Doctrine\nRun tests first.", promptMode: "code" },
  });
  const created = l3.getActivePersona(owner);
  assert.ok(created);
  assert.equal(created.promptMode, "code");
  assert.match(created.content, /Run tests first/);

  const edited = l3.upsertPersona(
    {
      owner,
      content: "User-authored doctrine",
      promptMode: "code",
      lastModifiedBy: "user",
      editedByUser: true,
    },
    created.version
  );
  await complete({
    kind: "L3_persona",
    scope,
    payload: { samples: ["new scene"], promptMode: "code", baselineVersion: edited.version },
    result: { content: "Pipeline replacement", promptMode: "code" },
  });

  const after = l3.getActivePersona(owner);
  assert.equal(after?.content, "User-authored doctrine");
  assert.equal(after?.editedByUser, true);
});
