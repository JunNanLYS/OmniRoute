import { createHash } from "node:crypto";

import { createMemory, getMemoryByPipelineKey, listMemories, updateMemory } from "../l1.ts";
import { getSceneById, listScenes, softDeleteScene, upsertScene } from "../l2.ts";
import { getActivePersona, upsertPersona } from "../l3.ts";
import { ownerFromApiKeyId } from "../integration/runtime.ts";
import { markL1TaskApplied, planPendingL1Task } from "../integration/l1Scheduling.ts";
import { initialDelayForKind, nextSceneScheduleMs } from "./scheduler.ts";
import type { DistillationTask, DistillationTaskKind, DistillationTaskResult } from "./store.ts";
import { L1_TYPES, L2_MAX_ACTIVE_PER_OWNER, type L1Type, type PromptMode } from "../types.ts";

const VALID_L1_TYPES: ReadonlySet<string> = new Set(L1_TYPES);
const L3_MEMORY_TRIGGER_COUNT = 50;
const MAX_L2_INPUT_MEMORIES = 100;
const MAX_L3_SAMPLES = 15;

interface EnqueueInput {
  kind: DistillationTaskKind;
  scope: string;
  payload: unknown;
  priority?: number;
  notBefore?: number;
  providerHint?: string | null;
  modelHint?: string | null;
  idempotencyKey?: string | null;
  coalesceKey?: string | null;
}

export interface DistillationApplyDeps {
  enqueueTask(input: EnqueueInput): unknown;
  now?: () => number;
}

export class DistillationApplyError extends Error {
  readonly code = "DISTILLATION_APPLY_INVALID";
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "DistillationApplyError";
  }
}

interface L1ApplyMemory {
  content: string;
  type: L1Type;
  priority: number;
  sourceMessageIds: string[];
  metadata: Record<string, unknown>;
}

interface L1ApplyScene {
  sceneName: string;
  messageIds: string[];
  memories: L1ApplyMemory[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return unique(
    value.filter((item): item is string => typeof item === "string" && item.length > 0)
  );
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function stableHash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0"), "utf8").digest("hex");
}

function normalizedContent(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function l1PipelineKey(sceneName: string, type: L1Type, content: string): string {
  return `l1:v1:${stableHash([sceneName, type, normalizedContent(content)])}`;
}

function parseL1Result(payload: unknown): L1ApplyScene[] {
  const root = asRecord(payload);
  if (!Array.isArray(root?.scenes)) {
    throw new DistillationApplyError("L1 result does not contain scenes");
  }
  const scenes: L1ApplyScene[] = [];
  let memoryCount = 0;
  for (const value of root.scenes.slice(0, 16)) {
    const scene = asRecord(value);
    if (!scene || !Array.isArray(scene.memories)) continue;
    const memories: L1ApplyMemory[] = [];
    for (const memoryValue of scene.memories) {
      if (memoryCount >= 32) break;
      const memory = asRecord(memoryValue);
      const content = nonEmptyString(memory?.content);
      const type = nonEmptyString(memory?.type);
      if (!memory || !content || !type || !VALID_L1_TYPES.has(type)) continue;
      memories.push({
        content: content.slice(0, 16_000),
        type: type as L1Type,
        priority: Math.round(bounded(memory.priority, 50, 0, 100)),
        sourceMessageIds: stringArray(memory.sourceMessageIds ?? memory.source_message_ids),
        metadata: asRecord(memory.metadata) ?? {},
      });
      memoryCount++;
    }
    if (memories.length === 0) continue;
    scenes.push({
      sceneName: nonEmptyString(scene.sceneName ?? scene.scene_name)?.slice(0, 240) ?? "未知情境",
      messageIds: stringArray(scene.messageIds ?? scene.message_ids),
      memories,
    });
  }
  if (scenes.length === 0) {
    throw new DistillationApplyError("L1 result contains no valid memories");
  }
  return scenes;
}

function taskSourceIds(task: DistillationTask): string[] {
  return stringArray(asRecord(task.payload)?.sourceMessageIds);
}

function trustedSourceIds(
  taskIds: readonly string[],
  memoryIds: readonly string[],
  sceneIds: readonly string[]
): string[] {
  if (taskIds.length === 0) return unique([...memoryIds, ...sceneIds]);
  const trusted = new Set(taskIds);
  const claimed = unique([...memoryIds, ...sceneIds]).filter((id) => trusted.has(id));
  return claimed.length > 0 ? claimed : [...taskIds];
}

function applyL1(
  task: DistillationTask,
  result: DistillationTaskResult,
  deps: DistillationApplyDeps
): void {
  const owner = ownerFromApiKeyId(task.scope);
  const taskPayload = asRecord(task.payload) ?? {};
  const allowedSourceIds = taskSourceIds(task);
  const affectedScenes = new Set<string>();
  const scenes = parseL1Result(result.payload);

  for (const scene of scenes) {
    for (const memory of scene.memories) {
      const pipelineKey = l1PipelineKey(scene.sceneName, memory.type, memory.content);
      const existing = getMemoryByPipelineKey(pipelineKey, owner, { includeDeleted: true });
      if (
        existing &&
        (existing.deletedAt !== null || existing.editedByUser || existing.lastModifiedBy === "user")
      ) {
        continue;
      }

      const sourceMessageIds = trustedSourceIds(
        allowedSourceIds,
        memory.sourceMessageIds,
        scene.messageIds
      );
      const metadata = {
        ...(existing?.metadata ?? {}),
        ...memory.metadata,
        distillationTaskId: task.id,
        sessionId: nonEmptyString(taskPayload.sessionId),
      };
      if (existing) {
        updateMemory(
          existing.id,
          owner,
          {
            content: memory.content,
            priority: Math.max(existing.priority, memory.priority),
            sceneName: scene.sceneName,
            sourceMessageIds: unique([...existing.sourceMessageIds, ...sourceMessageIds]),
            metadata,
            pipelineKey,
            lastModifiedBy: "pipeline",
            editedByUser: false,
          },
          existing.version
        );
      } else {
        createMemory({
          owner,
          type: memory.type,
          priority: memory.priority,
          sceneName: scene.sceneName,
          sourceMessageIds,
          metadata,
          pipelineKey,
          content: memory.content,
          lastModifiedBy: "pipeline",
          editedByUser: false,
        });
      }
      affectedScenes.add(scene.sceneName);
    }
  }

  const stateAdvanced = markL1TaskApplied({ scope: task.scope, payload: task.payload });
  if (stateAdvanced) {
    const nextL1 = planPendingL1Task({
      scope: task.scope,
      sessionId: nonEmptyString(taskPayload.sessionId) ?? "",
      correlationId: nonEmptyString(taskPayload.correlationId),
      capturedAt:
        nonEmptyString(taskPayload.capturedAt) ??
        new Date(deps.now?.() ?? Date.now()).toISOString(),
      now: deps.now?.() ?? Date.now(),
    });
    if (nextL1) deps.enqueueTask(nextL1);
  }

  const now = deps.now?.() ?? Date.now();
  for (const sceneName of affectedScenes) {
    const memories = listMemories({ owner, sceneName }).slice(0, MAX_L2_INPUT_MEMORIES);
    if (memories.length === 0) continue;
    const existingScene = listScenes({ owner }).find(
      (scene) => scene.sceneName === sceneName && scene.groupKey === null
    );
    const lastFiredAt = existingScene ? Date.parse(existingScene.updatedAt) : 0;
    deps.enqueueTask({
      kind: "L2_scene",
      scope: task.scope,
      payload: {
        sceneName,
        groupKey: null,
        conversation: memories.map((memory) => `${memory.type}: ${memory.content}`).join("\n"),
        sourceMemoryIds: memories.map((memory) => memory.id),
        sourceMessageIds: unique(memories.flatMap((memory) => memory.sourceMessageIds)),
      },
      priority: 3,
      notBefore: nextSceneScheduleMs(lastFiredAt, now),
      coalesceKey: `l2:v1:${stableHash([sceneName])}`,
    });
  }
}

function inferPromptMode(taskScope: string): PromptMode {
  const memories = listMemories({ owner: ownerFromApiKeyId(taskScope) });
  return memories.some((memory) => memory.type.startsWith("work_")) ? "code" : "chat";
}

function scheduleL3(
  task: DistillationTask,
  resultPayload: Record<string, unknown>,
  deps: DistillationApplyDeps
): void {
  const owner = ownerFromApiKeyId(task.scope);
  const persona = getActivePersona(owner);
  const scenes = listScenes({ owner });
  if (scenes.length === 0) return;
  const explicitRequest = resultPayload.personaUpdateRequested === true;
  const since = persona ? Date.parse(persona.updatedAt) : 0;
  const memoriesSincePersona = persona
    ? listMemories({ owner }).filter((memory) => Date.parse(memory.updatedAt) > since).length
    : 0;
  const shouldSchedule =
    explicitRequest ||
    !persona ||
    !persona.content.trim() ||
    memoriesSincePersona >= L3_MEMORY_TRIGGER_COUNT;
  if (!shouldSchedule) return;

  const taskPayload = asRecord(task.payload) ?? {};
  const requestedMode = nonEmptyString(taskPayload.promptMode);
  const promptMode: PromptMode =
    requestedMode === "chat" || requestedMode === "code"
      ? requestedMode
      : (persona?.promptMode ?? inferPromptMode(task.scope));
  deps.enqueueTask({
    kind: "L3_persona",
    scope: task.scope,
    payload: {
      samples: scenes
        .slice()
        .sort((a, b) => b.heat - a.heat)
        .slice(0, MAX_L3_SAMPLES)
        .map((scene) => `[${scene.sceneName}]\n${scene.summary}\n${scene.content}`),
      sourceSceneIds: scenes.map((scene) => scene.id),
      promptMode,
      baselineVersion: persona?.version ?? null,
      allowUserOverwrite: false,
    },
    priority: 4,
    notBefore: initialDelayForKind("L3_persona", deps.now?.() ?? Date.now()),
    coalesceKey: "l3:v1:persona",
  });
}

function applyL2(
  task: DistillationTask,
  result: DistillationTaskResult,
  deps: DistillationApplyDeps
): void {
  const owner = ownerFromApiKeyId(task.scope);
  const taskPayload = asRecord(task.payload) ?? {};
  const resultPayload = asRecord(result.payload);
  if (!resultPayload) throw new DistillationApplyError("L2 result must be an object");
  const existingById = nonEmptyString(taskPayload.sceneId)
    ? getSceneById(String(taskPayload.sceneId), owner)
    : null;
  const sceneName =
    nonEmptyString(taskPayload.sceneName) ??
    nonEmptyString(resultPayload.sceneName) ??
    existingById?.sceneName ??
    "default";
  const hasGroupKey = Object.prototype.hasOwnProperty.call(taskPayload, "groupKey");
  const groupKey = hasGroupKey
    ? nonEmptyString(taskPayload.groupKey)
    : (existingById?.groupKey ?? null);
  const allScenes = listScenes({ owner, includeDeleted: true });
  const deletedMatch = allScenes.find(
    (scene) =>
      scene.deletedAt !== null &&
      scene.sceneName === sceneName &&
      scene.groupKey === groupKey &&
      scene.editedByUser
  );
  if (deletedMatch && taskPayload.allowUserOverwrite !== true) return;
  const existing =
    existingById ??
    allScenes.find(
      (scene) =>
        scene.deletedAt === null && scene.sceneName === sceneName && scene.groupKey === groupKey
    ) ??
    null;
  const baselineVersion =
    typeof taskPayload.baselineVersion === "number" && Number.isInteger(taskPayload.baselineVersion)
      ? taskPayload.baselineVersion
      : null;
  if (existing && baselineVersion !== null && existing.version !== baselineVersion) {
    scheduleL3(task, resultPayload, deps);
    return;
  }
  if (existing?.editedByUser && taskPayload.allowUserOverwrite !== true) {
    scheduleL3(task, resultPayload, deps);
    return;
  }

  const summary = nonEmptyString(resultPayload.summary);
  const tags = stringArray(resultPayload.tags).slice(0, 8);
  if (!summary && tags.length === 0) {
    throw new DistillationApplyError("L2 result contains neither summary nor tags");
  }
  const content =
    nonEmptyString(resultPayload.content) ??
    nonEmptyString(taskPayload.conversation) ??
    summary ??
    tags.join(", ");
  const activeScenes = listScenes({ owner });
  if (!existing && activeScenes.length >= L2_MAX_ACTIVE_PER_OWNER) {
    const evictable = activeScenes
      .filter((scene) => !scene.editedByUser && scene.lastModifiedBy === "pipeline")
      .sort((a, b) => a.heat - b.heat || a.updatedAt.localeCompare(b.updatedAt))[0];
    if (!evictable) {
      throw new DistillationApplyError("L2 capacity is full with user-owned scenes");
    }
    softDeleteScene(evictable.id, owner, "pipeline");
  }
  upsertScene({
    owner,
    sceneName: sceneName.slice(0, 240),
    groupKey,
    summary: (summary ?? tags.join(", ")).slice(0, 1_200),
    heat: bounded(resultPayload.heat, existing?.heat ?? 0.5, 0, 1),
    content: content.slice(0, 32_000),
    mergeHeat: existing !== null,
    lastModifiedBy: "pipeline",
    editedByUser: false,
  });
  scheduleL3(task, resultPayload, deps);
}

function personaContent(payload: Record<string, unknown>): string | null {
  const direct = nonEmptyString(payload.content);
  if (direct) return direct;
  const persona = payload.persona;
  if (typeof persona === "string") return nonEmptyString(persona);
  if (persona && typeof persona === "object") return JSON.stringify(persona, null, 2);
  return null;
}

function applyL3(task: DistillationTask, result: DistillationTaskResult): void {
  const owner = ownerFromApiKeyId(task.scope);
  const taskPayload = asRecord(task.payload) ?? {};
  const resultPayload = asRecord(result.payload);
  if (!resultPayload) throw new DistillationApplyError("L3 result must be an object");
  const content = personaContent(resultPayload);
  if (!content) throw new DistillationApplyError("L3 result contains no persona content");
  const existing = getActivePersona(owner);
  const latest = getActivePersona(owner, { includeDeleted: true });
  const allowUserOverwrite = taskPayload.allowUserOverwrite === true;
  if (existing?.editedByUser && !allowUserOverwrite) return;
  const baselineDeclared = Object.prototype.hasOwnProperty.call(taskPayload, "baselineVersion");
  const baselineVersion =
    typeof taskPayload.baselineVersion === "number" && Number.isInteger(taskPayload.baselineVersion)
      ? taskPayload.baselineVersion
      : null;
  if (
    latest?.deletedAt !== null &&
    baselineVersion !== null &&
    latest?.version === baselineVersion
  ) {
    return;
  }
  if (baselineDeclared && baselineVersion === null && latest) return;
  if (existing && baselineVersion !== null && existing.version !== baselineVersion) return;
  const requestedMode = nonEmptyString(resultPayload.promptMode ?? taskPayload.promptMode);
  const promptMode: PromptMode =
    requestedMode === "code" || requestedMode === "chat"
      ? requestedMode
      : (existing?.promptMode ?? inferPromptMode(task.scope));
  upsertPersona(
    {
      owner,
      content: content.slice(0, 64_000),
      promptMode,
      lastModifiedBy: "pipeline",
      editedByUser: false,
    },
    existing?.version
  );
}

export function applyDistillationResult(
  task: DistillationTask,
  result: DistillationTaskResult,
  deps: DistillationApplyDeps
): void {
  switch (task.kind) {
    case "L0_chunk_embed":
      return;
    case "L1_extract":
      applyL1(task, result, deps);
      return;
    case "L2_scene":
      applyL2(task, result, deps);
      return;
    case "L3_persona":
      applyL3(task, result);
      return;
  }
}
