import type {
  DistillationDlqEntry,
  DistillationSelector,
  DistillationUsageRecord,
  DistillationUsageSummary,
  ListDistillationUsageResult,
  ListResult,
  MemoryListingQuery,
  MemoryFourLayerService,
  MemoryL0,
  MemoryL1,
  MemoryL2,
  MemoryL3,
  MemoryRequestScope,
  MemoryServiceContext,
} from "../api/dependencies.ts";
import { MemoryOptimisticConflictError } from "../api/dependencies.ts";
import {
  createMemory,
  getMemoryById,
  getMemoryHistory,
  listMemories,
  MemoryVersionConflictError,
  permanentDeleteMemory,
  restoreMemory,
  searchMemories,
  softDeleteMemory,
  updateMemory,
} from "../l1.ts";
import {
  createScene,
  getSceneById,
  listScenes,
  permanentDeleteScene,
  restoreScene,
  SceneVersionConflictError,
  softDeleteScene,
  updateScene,
} from "../l2.ts";
import {
  clearPersona,
  getActivePersona,
  permanentDeletePersona,
  PersonaVersionConflictError,
  restorePersona,
  upsertPersona,
} from "../l3.ts";
import {
  getMessageById,
  insertMessage,
  listMessages,
  permanentDeleteMessage,
  restoreMessage,
  softDeleteMessage,
} from "../l0.ts";
import { parseDistillationModelOverride } from "../distillation/config.ts";
import {
  enqueueDistillationTask,
  getDistillationDlqStatusCounts,
  getDistillationTask,
  listDistillationDlqEntries,
  listDistillationUsageRecords,
  retryDistillationDlqEntries,
  type PersistentDistillationDlqEntry,
} from "./repositories/distillation.ts";
import { getSetting, softDeleteSetting, upsertSetting } from "../operations.ts";
import {
  deleteMemoryPipelineSettingsOverride,
  resolveMemoryPipelineSettingsConfig,
  saveMemoryPipelineSettingsOverride,
} from "../integration/settings.ts";
import { readL0CaptureTelemetry } from "./repositories/l0CaptureTelemetry.ts";
import type { L0Message, L1Memory, L2Scene, L3Persona } from "../types.ts";
import type {
  DistillationDlqRetry,
  DistillationPut,
  L0DeleteAll,
  L0DeleteBody,
  L0Import,
  L1Create,
  L1DeleteBody,
  L1Update,
  L2Create,
  L2DeleteBody,
  L2Regenerate,
  L2Update,
  L3DeleteBody,
  L3Regenerate,
  L3Upsert,
} from "@/shared/schemas/memoryFourLayer";

const SELECTOR_GLOBAL_KEY = "distillation.selector.global";
const SELECTOR_PER_KEY_PREFIX = "distillation.selector.per-key.";

function selectorPerKeySetting(apiKeyId: string): string {
  return `${SELECTOR_PER_KEY_PREFIX}${apiKeyId}`;
}

function assertScope(scope: MemoryRequestScope): void {
  if (!scope.ownerApiKeyId || scope.owner.userId !== scope.ownerApiKeyId) {
    throw new Error("[memory.api] a resolved owner scope is required");
  }
}

function includeDeleted(query: MemoryListingQuery): boolean {
  return query.includeDeleted === "deleted" || query.includeDeleted === "any";
}

function filterRecycle<T extends { deletedAt: string | null }>(
  rows: readonly T[],
  query: MemoryListingQuery
): T[] {
  if (query.includeDeleted === "deleted") return rows.filter((row) => row.deletedAt !== null);
  if (query.includeDeleted === "any") return [...rows];
  return rows.filter((row) => row.deletedAt === null);
}

function paginate<T>(rows: readonly T[], query: MemoryListingQuery): ListResult<T> {
  const limit = Math.min(100, Math.max(1, Math.floor(query.limit ?? 20)));
  const offset = Math.max(
    0,
    Math.floor(query.offset ?? (Math.max(1, Math.floor(query.page ?? 1)) - 1) * limit)
  );
  const page =
    query.offset === undefined
      ? Math.max(1, Math.floor(query.page ?? 1))
      : 1 + Math.floor(offset / limit);
  return {
    data: rows.slice(offset, offset + limit),
    total: rows.length,
    page,
    limit,
  };
}

function mapL0(row: L0Message, ownerApiKeyId: string): MemoryL0 {
  return {
    id: row.id,
    ownerApiKeyId,
    sessionKey: row.sessionKey,
    sessionId: row.sessionId,
    role: row.role,
    content: row.content,
    timestamp: row.timestamp,
    recordedAt: row.recordedAt,
    source: row.source,
    correlationId: row.correlationId,
    comboExecutionKey: row.comboExecutionKey,
    isInternal: row.isInternal,
    provider: row.provider,
    model: row.model,
    truncated: row.truncated,
    idempotencyKey: row.idempotencyKey,
    deletedAt: row.deletedAt,
  };
}

function mapL1(row: L1Memory, ownerApiKeyId: string): MemoryL1 {
  return {
    id: row.id,
    ownerApiKeyId,
    type: row.type,
    priority: row.priority,
    content: row.content,
    sceneName: row.sceneName,
    metadata: row.metadata,
    sourceMessageIds: row.sourceMessageIds,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastModifiedBy: row.lastModifiedBy,
    editedByUser: row.editedByUser,
    deletedAt: row.deletedAt,
  };
}

function mapL2(row: L2Scene, ownerApiKeyId: string): MemoryL2 {
  return {
    id: row.id,
    ownerApiKeyId,
    sceneName: row.sceneName,
    groupKey: row.groupKey,
    summary: row.summary,
    heat: row.heat,
    content: row.content,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastModifiedBy: row.lastModifiedBy,
    editedByUser: row.editedByUser,
    deletedAt: row.deletedAt,
  };
}

function mapL3(row: L3Persona, ownerApiKeyId: string): MemoryL3 {
  return {
    id: row.personaId,
    ownerApiKeyId,
    content: row.content,
    promptMode: row.promptMode,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastModifiedBy: row.lastModifiedBy,
    editedByUser: row.editedByUser,
    deletedAt: row.deletedAt,
  };
}

function parseSelectorSetting(
  raw: string | null,
  sourceLayer: "per-key" | "global",
  apiKeyId: string | null
): DistillationSelector | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { provider?: unknown; modelId?: unknown };
    if (typeof value.provider !== "string" || typeof value.modelId !== "string") return null;
    return {
      provider: value.provider,
      modelId: value.modelId,
      sourceLayer,
      apiKeyId,
      scope: sourceLayer === "per-key" ? "self" : "global",
    };
  } catch {
    return null;
  }
}

function sourceLayerForTask(kind: string): DistillationDlqEntry["sourceLayer"] {
  if (kind === "L0_chunk_embed") return "l0";
  if (kind === "L1_extract") return "l1";
  if (kind === "L3_persona") return "l3";
  return "l2";
}

function sourceIdForTask(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["sourceId", "messageId", "memoryId", "sceneId", "personaId"] as const) {
    if (typeof record[key] === "string") return record[key];
  }
  return null;
}

function mapDlq(row: PersistentDistillationDlqEntry): DistillationDlqEntry {
  const task = getDistillationTask(row.taskId);
  return {
    id: String(row.id),
    ownerApiKeyId: row.scope,
    sourceLayer: sourceLayerForTask(task?.kind ?? "L2_scene"),
    sourceId: sourceIdForTask(task?.payload),
    errorMessage: row.error,
    errorAt: new Date(row.recordedAt).toISOString(),
    retryCount: row.retryCount,
    status: row.status,
    lastErrorCode: row.lastErrorCode,
  };
}

function contextOwnerApiKeyId(
  context: MemoryServiceContext,
  explicit?: string | null
): string | null {
  return explicit ?? context.ownerApiKeyId ?? context.actor.apiKeyId;
}

function assertSelectorAccess(
  context: MemoryServiceContext,
  selectorScope: DistillationPut["scope"],
  apiKeyId: string | null
): void {
  if (selectorScope === "global") {
    if (!context.actor.isManagement) throw new Error("[memory.api] management scope required");
    return;
  }
  if (!apiKeyId) throw new Error("[memory.api] self selector requires an owner");
  if (!context.actor.isManagement && apiKeyId !== context.actor.apiKeyId) {
    throw new Error("[memory.api] cross-owner selector access denied");
  }
}

export function createFourLayerService(): MemoryFourLayerService {
  return {
    async importL0(scope: MemoryRequestScope, data: L0Import) {
      assertScope(scope);
      const importedIds = data.items.map(
        (item) =>
          insertMessage({
            owner: scope.owner,
            sessionKey: data.sessionId,
            sessionId: data.sessionId,
            role: item.role,
            content: item.content,
            source: "imported",
            correlationId: item.correlationId ?? null,
            comboExecutionKey: null,
            isInternal: false,
            provider: item.provider ?? null,
            model: item.model ?? null,
            truncated: false,
            idempotencyKey: item.idempotencyKey,
            timestamp: item.timestamp?.toISOString(),
          }).id
      );
      return { importedIds };
    },

    async listL0(scope: MemoryRequestScope, query: L1ListingQuery) {
      assertScope(scope);
      let rows = listMessages({
        owner: scope.owner,
        sessionId: query.sessionId,
        includeDeleted: includeDeleted(query),
      }).map((row) => mapL0(row, scope.ownerApiKeyId));
      rows = filterRecycle(rows, query);
      if (query.q) {
        const needle = query.q.toLocaleLowerCase();
        rows = rows.filter((row) => row.content.toLocaleLowerCase().includes(needle));
      }
      return paginate(rows, query);
    },

    async getL0(scope: MemoryRequestScope, id: string) {
      assertScope(scope);
      const row = getMessageById(id, scope.owner);
      return row ? mapL0(row, scope.ownerApiKeyId) : null;
    },

    async deleteL0(scope: MemoryRequestScope, id: string, mode: L0DeleteBody["mode"]) {
      assertScope(scope);
      const current = getMessageById(id, scope.owner);
      if (!current || (mode === "soft" && current.deletedAt)) return false;
      if (mode === "permanent") permanentDeleteMessage(id, scope.owner);
      else softDeleteMessage(id, scope.owner);
      return true;
    },

    async deleteL0Session(scope: MemoryRequestScope, sessionId: string, mode: L0DeleteAll["mode"]) {
      assertScope(scope);
      const rows = listMessages({ owner: scope.owner, sessionId, includeDeleted: true }).filter(
        (row) => mode === "permanent" || row.deletedAt === null
      );
      for (const row of rows) {
        if (mode === "permanent") permanentDeleteMessage(row.id, scope.owner);
        else softDeleteMessage(row.id, scope.owner);
      }
      return { deleted: rows.length };
    },

    async restoreL0(scope: MemoryRequestScope, id: string) {
      assertScope(scope);
      const current = getMessageById(id, scope.owner);
      if (!current || current.deletedAt === null) return null;
      restoreMessage(id, scope.owner);
      const restored = getMessageById(id, scope.owner);
      return restored ? mapL0(restored, scope.ownerApiKeyId) : null;
    },

    async createL1(scope: MemoryRequestScope, data: L1Create) {
      assertScope(scope);
      return mapL1(
        createMemory({
          owner: scope.owner,
          type: data.type,
          priority: data.priority,
          sceneName: data.sceneName,
          sourceMessageIds: data.sourceMessageIds,
          metadata: data.metadata,
          content: data.content,
          lastModifiedBy: "user",
          editedByUser: true,
        }),
        scope.ownerApiKeyId
      );
    },

    async listL1(scope: MemoryRequestScope, query: L1ListingQuery) {
      assertScope(scope);
      let rows = listMemories({
        owner: scope.owner,
        type: query.type as L1Create["type"] | undefined,
        sceneName: query.sceneName,
        includeDeleted: includeDeleted(query),
      }).map((row) => mapL1(row, scope.ownerApiKeyId));
      rows = filterRecycle(rows, query);
      return paginate(rows, query);
    },

    async searchL1(scope: MemoryRequestScope, query: L1ListingQuery) {
      assertScope(scope);
      const needle = query.q?.trim() ?? "";
      let rows =
        needle && !includeDeleted(query)
          ? searchMemories({ owner: scope.owner, query: needle })
          : listMemories({
              owner: scope.owner,
              type: query.type as L1Create["type"] | undefined,
              sceneName: query.sceneName,
              includeDeleted: includeDeleted(query),
            });
      if (needle && includeDeleted(query)) {
        const lowered = needle.toLocaleLowerCase();
        rows = rows.filter((row) => row.content.toLocaleLowerCase().includes(lowered));
      }
      let mapped = rows.map((row) => mapL1(row, scope.ownerApiKeyId));
      mapped = filterRecycle(mapped, query);
      if (query.type) mapped = mapped.filter((row) => row.type === query.type);
      if (query.sceneName) mapped = mapped.filter((row) => row.sceneName === query.sceneName);
      return paginate(mapped, query);
    },

    async getL1(scope: MemoryRequestScope, id: string) {
      assertScope(scope);
      const row = getMemoryById(id, scope.owner);
      return row ? mapL1(row, scope.ownerApiKeyId) : null;
    },

    async updateL1(scope: MemoryRequestScope, id: string, data: L1Update) {
      assertScope(scope);
      const { expectedVersion, ...update } = data;
      try {
        const entry = updateMemory(
          id,
          scope.owner,
          { ...update, lastModifiedBy: "user", editedByUser: true },
          expectedVersion
        );
        return { entry: mapL1(entry, scope.ownerApiKeyId), conflict: false };
      } catch (error) {
        if (error instanceof MemoryVersionConflictError) {
          return { entry: mapL1(error.current, scope.ownerApiKeyId), conflict: true };
        }
        throw error;
      }
    },

    async deleteL1(scope: MemoryRequestScope, id: string, mode: L1DeleteBody["mode"]) {
      assertScope(scope);
      const exists =
        mode === "permanent"
          ? getMemoryHistory(id, scope.owner).length > 0
          : getMemoryById(id, scope.owner) !== null;
      if (!exists) return false;
      if (mode === "permanent") permanentDeleteMemory(id, scope.owner);
      else softDeleteMemory(id, scope.owner);
      return true;
    },

    async restoreL1(scope: MemoryRequestScope, id: string) {
      assertScope(scope);
      if (getMemoryHistory(id, scope.owner).length === 0 || getMemoryById(id, scope.owner))
        return null;
      restoreMemory(id, scope.owner);
      const restored = getMemoryById(id, scope.owner);
      return restored ? mapL1(restored, scope.ownerApiKeyId) : null;
    },

    async createL2(scope: MemoryRequestScope, data: L2Create) {
      assertScope(scope);
      return mapL2(
        createScene({
          owner: scope.owner,
          sceneName: data.sceneName,
          groupKey: data.groupKey,
          summary: data.summary,
          heat: data.heat,
          content: data.content,
          lastModifiedBy: "user",
          editedByUser: true,
        }),
        scope.ownerApiKeyId
      );
    },

    async listL2(scope: MemoryRequestScope, query: L1ListingQuery) {
      assertScope(scope);
      let rows = listScenes({ owner: scope.owner, includeDeleted: includeDeleted(query) }).map(
        (row) => mapL2(row, scope.ownerApiKeyId)
      );
      rows = filterRecycle(rows, query);
      if (query.sceneName) rows = rows.filter((row) => row.sceneName === query.sceneName);
      if (query.q) {
        const needle = query.q.toLocaleLowerCase();
        rows = rows.filter(
          (row) =>
            row.content.toLocaleLowerCase().includes(needle) ||
            row.summary.toLocaleLowerCase().includes(needle)
        );
      }
      return paginate(rows, query);
    },

    async getL2(scope: MemoryRequestScope, id: string) {
      assertScope(scope);
      const row = getSceneById(id, scope.owner);
      return row ? mapL2(row, scope.ownerApiKeyId) : null;
    },

    async updateL2(scope: MemoryRequestScope, id: string, data: L2Update) {
      assertScope(scope);
      const { expectedVersion, ...update } = data;
      try {
        const entry = updateScene(id, scope.owner, update, expectedVersion);
        return { entry: mapL2(entry, scope.ownerApiKeyId), conflict: false };
      } catch (error) {
        if (error instanceof SceneVersionConflictError) {
          return { entry: mapL2(error.current, scope.ownerApiKeyId), conflict: true };
        }
        throw error;
      }
    },

    async deleteL2(scope: MemoryRequestScope, id: string, mode: L2DeleteBody["mode"]) {
      assertScope(scope);
      const current = listScenes({ owner: scope.owner, includeDeleted: true }).find(
        (row) => row.id === id
      );
      if (!current || (mode === "soft" && current.deletedAt)) return false;
      if (mode === "permanent") permanentDeleteScene(id, scope.owner);
      else softDeleteScene(id, scope.owner);
      return true;
    },

    async restoreL2(scope: MemoryRequestScope, id: string) {
      assertScope(scope);
      const current = listScenes({ owner: scope.owner, includeDeleted: true }).find(
        (row) => row.id === id
      );
      if (!current || current.deletedAt === null) return null;
      restoreScene(id, scope.owner);
      const restored = getSceneById(id, scope.owner);
      return restored ? mapL2(restored, scope.ownerApiKeyId) : null;
    },

    async regenerateL2(scope: MemoryRequestScope, id: string, data: L2Regenerate) {
      assertScope(scope);
      const scene = getSceneById(id, scope.owner);
      if (!scene) throw new Error("[memory.l2] scene not found");
      const memories = listMemories({ owner: scope.owner, sceneName: scene.sceneName });
      const source = memories.length > 0 ? memories : listMemories({ owner: scope.owner });
      enqueueDistillationTask({
        kind: "L2_scene",
        scope: scope.ownerApiKeyId,
        payload: {
          sceneId: id,
          sceneName: scene.sceneName,
          groupKey: scene.groupKey,
          conversation: source
            .slice(0, 100)
            .map((memory) => `${memory.type}: ${memory.content}`)
            .join("\n"),
          sourceMemoryIds: source.slice(0, 100).map((memory) => memory.id),
          sourceMessageIds: Array.from(
            new Set(source.slice(0, 100).flatMap((memory) => memory.sourceMessageIds))
          ),
          baselineVersion: scene.version,
          allowUserOverwrite: true,
          reason: data.reason ?? null,
        },
        priority: 5,
        notBefore: Date.now(),
        idempotencyKey: `l2:manual:${id}:v${scene.version}`,
      });
      return { enqueued: 1 };
    },

    async listL3(scope: MemoryRequestScope, query: L1ListingQuery) {
      assertScope(scope);
      const row = getActivePersona(scope.owner, { includeDeleted: includeDeleted(query) });
      const mapped = row ? [mapL3(row, scope.ownerApiKeyId)] : [];
      return paginate(filterRecycle(mapped, query), query);
    },

    async getL3(scope: MemoryRequestScope, id: string) {
      assertScope(scope);
      const row = getActivePersona(scope.owner);
      return row?.personaId === id ? mapL3(row, scope.ownerApiKeyId) : null;
    },

    async upsertL3(scope: MemoryRequestScope, data: L3Upsert) {
      assertScope(scope);
      try {
        return mapL3(
          upsertPersona(
            {
              owner: scope.owner,
              content: data.content,
              promptMode: data.promptMode,
              lastModifiedBy: "user",
              editedByUser: true,
            },
            data.expectedVersion
          ),
          scope.ownerApiKeyId
        );
      } catch (error) {
        if (error instanceof PersonaVersionConflictError) {
          throw new MemoryOptimisticConflictError();
        }
        throw error;
      }
    },

    async deleteL3(scope: MemoryRequestScope, id: string, mode: L3DeleteBody["mode"]) {
      assertScope(scope);
      if (mode === "restore") return Boolean(await this.restoreL3(scope, id));
      const current = getActivePersona(scope.owner, { includeDeleted: mode === "permanent" });
      if (!current || current.personaId !== id || (mode === "soft" && current.deletedAt))
        return false;
      if (mode === "permanent") permanentDeletePersona(scope.owner);
      else clearPersona(scope.owner);
      return true;
    },

    async restoreL3(scope: MemoryRequestScope, id: string) {
      assertScope(scope);
      const current = getActivePersona(scope.owner, { includeDeleted: true });
      if (!current || current.personaId !== id || current.deletedAt === null) return null;
      restorePersona(scope.owner);
      const restored = getActivePersona(scope.owner);
      return restored ? mapL3(restored, scope.ownerApiKeyId) : null;
    },

    async regenerateL3(scope: MemoryRequestScope, data: L3Regenerate) {
      assertScope(scope);
      const persona = getActivePersona(scope.owner);
      const scenes = listScenes({ owner: scope.owner })
        .slice()
        .sort((a, b) => b.heat - a.heat)
        .slice(0, 15);
      if (scenes.length === 0) throw new Error("[memory.l3] no scenes available");
      const promptMode =
        persona?.promptMode ??
        (listMemories({ owner: scope.owner }).some((memory) => memory.type.startsWith("work_"))
          ? "code"
          : "chat");
      enqueueDistillationTask({
        kind: "L3_persona",
        scope: scope.ownerApiKeyId,
        payload: {
          samples: scenes.map(
            (scene) => `[${scene.sceneName}]\n${scene.summary}\n${scene.content}`
          ),
          sourceSceneIds: scenes.map((scene) => scene.id),
          promptMode,
          baselineVersion: persona?.version ?? null,
          allowUserOverwrite: true,
          reason: data.reason ?? null,
        },
        priority: 5,
        notBefore: Date.now(),
        idempotencyKey: `l3:manual:v${persona?.version ?? 0}:${scenes
          .map((scene) => `${scene.id}@${scene.version}`)
          .join(":")}`,
      });
      return { enqueued: 1 };
    },

    async getMemoryPipelineSettings(scope: MemoryRequestScope) {
      assertScope(scope);
      return resolveMemoryPipelineSettingsConfig(scope.ownerApiKeyId);
    },

    async setMemoryPipelineSettings(scope: MemoryRequestScope, data) {
      assertScope(scope);
      return saveMemoryPipelineSettingsOverride(scope.ownerApiKeyId, data);
    },

    async deleteMemoryPipelineSettings(scope: MemoryRequestScope) {
      assertScope(scope);
      return deleteMemoryPipelineSettingsOverride(scope.ownerApiKeyId);
    },

    async getDistillationSelector(context: MemoryServiceContext, apiKeyId?: string | null) {
      const target = contextOwnerApiKeyId(context, apiKeyId);
      if (!target) throw new Error("[memory.api] selector owner is required");
      if (!context.actor.isManagement && target !== context.actor.apiKeyId) {
        throw new Error("[memory.api] cross-owner selector access denied");
      }
      const perKey = parseSelectorSetting(
        getSetting(selectorPerKeySetting(target))?.value ?? null,
        "per-key",
        target
      );
      if (perKey) return perKey;
      const global = parseSelectorSetting(
        getSetting(SELECTOR_GLOBAL_KEY)?.value ?? null,
        "global",
        null
      );
      if (global) return global;
      const env = parseDistillationModelOverride(process.env.MEMORY_DISTILLATION_MODEL);
      if (env) {
        return {
          provider: env.provider,
          modelId: env.model,
          sourceLayer: "env",
          apiKeyId: null,
          scope: null,
        };
      }
      return {
        provider: "auto",
        modelId: "auto",
        sourceLayer: "auto",
        apiKeyId: null,
        scope: null,
      };
    },

    async setDistillationSelector(context: MemoryServiceContext, data: DistillationPut) {
      const target = data.scope === "self" ? contextOwnerApiKeyId(context, data.apiKeyId) : null;
      assertSelectorAccess(context, data.scope, target);
      const selector: DistillationSelector = {
        provider: data.provider,
        modelId: data.modelId,
        sourceLayer: data.scope === "self" ? "per-key" : "global",
        apiKeyId: target,
        scope: data.scope,
      };
      upsertSetting(
        data.scope === "self" ? selectorPerKeySetting(target!) : SELECTOR_GLOBAL_KEY,
        JSON.stringify({ provider: data.provider, modelId: data.modelId })
      );
      return selector;
    },

    async deleteDistillationSelector(
      context: MemoryServiceContext,
      selectorScope: DistillationPut["scope"],
      apiKeyId?: string | null
    ) {
      const target = selectorScope === "self" ? contextOwnerApiKeyId(context, apiKeyId) : null;
      assertSelectorAccess(context, selectorScope, target);
      const key = selectorScope === "self" ? selectorPerKeySetting(target!) : SELECTOR_GLOBAL_KEY;
      if (!getSetting(key)) return false;
      softDeleteSetting(key);
      return true;
    },

    async listDistillationDlq(scope: MemoryRequestScope, options) {
      assertScope(scope);
      const entries = listDistillationDlqEntries({
        scope: scope.ownerApiKeyId,
        statuses: options.statuses,
        limit: options.limit,
      }).map(mapDlq);
      return {
        entries,
        statusCounts: getDistillationDlqStatusCounts(scope.ownerApiKeyId),
      };
    },

    async retryDistillationDlq(scope: MemoryRequestScope, data: DistillationDlqRetry) {
      assertScope(scope);
      const candidates = listDistillationDlqEntries({
        scope: scope.ownerApiKeyId,
        statuses: ["pending"],
        limit: 500,
      });
      const requested = data.all
        ? candidates.map((entry) => entry.id)
        : (data.ids ?? [])
            .map((id) => Number(id))
            .filter((id) => Number.isSafeInteger(id) && id > 0);
      const allowed = new Set(candidates.map((entry) => entry.id));
      const scopedIds = requested.filter((id) => allowed.has(id));
      const denied = requested.length - scopedIds.length;
      const result = retryDistillationDlqEntries(scopedIds, scope.ownerApiKeyId);
      return { retried: result.retried, skipped: result.skipped + denied };
    },

    async listDistillationUsage(
      scope: MemoryRequestScope,
      options: { limit: number }
    ): Promise<ListDistillationUsageResult> {
      assertScope(scope);
      const records = listDistillationUsageRecords({
        scope: scope.ownerApiKeyId,
        limit: options.limit,
      });
      const mapped: DistillationUsageRecord[] = records.map((row, index) => ({
        id: index + 1,
        ownerApiKeyId: row.scope,
        kind: row.kind,
        provider: row.provider,
        model: row.model,
        tokens: row.tokens,
        usd: row.usd,
        recordedAt: new Date(row.recordedAt).toISOString(),
      }));
      const totals: DistillationUsageSummary = mapped.reduce(
        (acc, row) => ({
          tokens: acc.tokens + row.tokens,
          usd: acc.usd + row.usd,
          tasks: acc.tasks + 1,
        }),
        { tokens: 0, usd: 0, tasks: 0 }
      );
      return { records: mapped, totals };
    },

    async getL0CaptureStatus(scope: MemoryRequestScope) {
      assertScope(scope);
      return readL0CaptureTelemetry(scope.ownerApiKeyId);
    },
  };
}
