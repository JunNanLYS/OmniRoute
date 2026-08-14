/**
 * Helper — build an in-memory fake service that satisfies the four-layer
 * interface. Tests use it to assert handler contracts without touching SQL.
 */
import type {
  AuthSubject,
  DistillationDlqEntry,
  DistillationSelector,
  ListResult,
  MemoryFourLayerService,
  MemoryL0,
  MemoryL1,
  MemoryL2,
  MemoryL3,
  RegenerateEnqueueResult,
} from "../../src/memory/api/dependencies.ts";

interface FakeState {
  l0: Map<string, MemoryL0>;
  l1: Map<string, MemoryL1>;
  l2: Map<string, MemoryL2>;
  l3: Map<string, MemoryL3>;
  selectors: {
    perKey: Map<string, DistillationSelector>;
    global: DistillationSelector | null;
  };
  dlq: Map<string, DistillationDlqEntry>;
  audit: { action: string; target: string; resourceType: string }[];
}

export function createFakeState(): FakeState {
  return {
    l0: new Map(),
    l1: new Map(),
    l2: new Map(),
    l3: new Map(),
    selectors: { perKey: new Map(), global: null },
    dlq: new Map(),
    audit: [],
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function paginate<T>(items: T[], page: number, limit: number): ListResult<T> {
  const total = items.length;
  const start = (page - 1) * limit;
  return { data: items.slice(start, start + limit), total, page, limit };
}

export function buildFakeService(state: FakeState): MemoryFourLayerService {
  return {
    // L0
    importL0: async ({ actor, data }) => {
      if (actor.actor === "apiKey" && data.apiKeyId !== actor.apiKeyId) {
        throw new Error("cross-owner forbidden");
      }
      const ids: string[] = [];
      for (const item of data.items) {
        const id = `l0-${state.l0.size + 1}`;
        state.l0.set(id, {
          id,
          ownerApiKeyId: data.apiKeyId,
          sessionId: data.sessionId,
          sourceId: item.sourceId ?? null,
          sceneName: item.sceneName ?? null,
          payload: item.payload,
          occurredAt: (item.occurredAt ?? new Date()).toISOString(),
          createdAt: nowIso(),
          deletedAt: null,
        });
        ids.push(id);
      }
      return { importedIds: ids };
    },
    listL0: async (actor, q) => {
      const page = q.page ?? 1;
      const limit = q.limit ?? 20;
      const owner = actor.actor === "apiKey" ? actor.apiKeyId : (q.apiKeyId ?? null);
      let items = Array.from(state.l0.values()).filter((e) => {
        if (owner && e.ownerApiKeyId !== owner) return false;
        if (q.sessionId && e.sessionId !== q.sessionId) return false;
        if (q.includeDeleted === "active" && e.deletedAt) return false;
        if (q.includeDeleted === "deleted" && !e.deletedAt) return false;
        return true;
      });
      return paginate(items, page, limit);
    },
    getL0: async (actor, id) => {
      const e = state.l0.get(id) ?? null;
      if (!e) return null;
      if (actor.actor === "apiKey" && e.ownerApiKeyId !== actor.apiKeyId) return null;
      return e;
    },
    deleteL0: async (actor, id, mode) => {
      const e = state.l0.get(id);
      if (!e) return false;
      if (actor.actor === "apiKey" && e.ownerApiKeyId !== actor.apiKeyId) return false;
      if (mode === "permanent") state.l0.delete(id);
      else e.deletedAt = nowIso();
      return true;
    },
    deleteL0Session: async (actor, sessionId, mode) => {
      const owner = actor.actor === "apiKey" ? actor.apiKeyId : null;
      let deleted = 0;
      for (const e of Array.from(state.l0.values())) {
        if (owner && e.ownerApiKeyId !== owner) continue;
        if (e.sessionId !== sessionId) continue;
        if (mode === "permanent") state.l0.delete(e.id);
        else e.deletedAt = nowIso();
        deleted++;
      }
      return { deleted };
    },
    restoreL0: async (actor, id) => {
      const e = state.l0.get(id);
      if (!e) return null;
      if (actor.actor === "apiKey" && e.ownerApiKeyId !== actor.apiKeyId) return null;
      e.deletedAt = null;
      return e;
    },

    // L1
    createL1: async (actor, data) => {
      const owner = data.apiKeyId ?? actor.apiKeyId ?? "unknown";
      const id = `l1-${state.l1.size + 1}`;
      const entry: MemoryL1 = {
        id,
        ownerApiKeyId: owner,
        type: data.type,
        priority: data.priority,
        content: data.content,
        sceneName: data.sceneName,
        metadata: data.metadata,
        sourceId: data.sourceId ?? null,
        version: 1,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        deletedAt: null,
      };
      state.l1.set(id, entry);
      return entry;
    },
    listL1: async (actor, q) => {
      const page = q.page ?? 1;
      const limit = q.limit ?? 20;
      const owner = actor.actor === "apiKey" ? actor.apiKeyId : (q.apiKeyId ?? null);
      const items = Array.from(state.l1.values()).filter((e) => {
        if (owner && e.ownerApiKeyId !== owner) return false;
        if (q.type && e.type !== q.type) return false;
        if (q.sceneName && e.sceneName !== q.sceneName) return false;
        if (q.includeDeleted === "active" && e.deletedAt) return false;
        if (q.includeDeleted === "deleted" && !e.deletedAt) return false;
        return true;
      });
      return paginate(items, page, limit);
    },
    searchL1: async (actor, q) => {
      const page = q.page ?? 1;
      const limit = q.limit ?? 20;
      const owner = actor.actor === "apiKey" ? actor.apiKeyId : (q.apiKeyId ?? null);
      const needle = (q.q ?? "").toLowerCase();
      const items = Array.from(state.l1.values()).filter((e) => {
        if (owner && e.ownerApiKeyId !== owner) return false;
        if (needle && !e.content.toLowerCase().includes(needle)) return false;
        if (q.includeDeleted === "active" && e.deletedAt) return false;
        if (q.includeDeleted === "deleted" && !e.deletedAt) return false;
        return true;
      });
      return paginate(items, page, limit);
    },
    getL1: async (actor, id) => {
      const e = state.l1.get(id) ?? null;
      if (!e) return null;
      if (actor.actor === "apiKey" && e.ownerApiKeyId !== actor.apiKeyId) return null;
      return e;
    },
    updateL1: async (actor, id, data) => {
      const e = state.l1.get(id);
      if (!e) throw new Error("not found");
      if (actor.actor === "apiKey" && e.ownerApiKeyId !== actor.apiKeyId)
        throw new Error("forbidden");
      if (data.expectedVersion !== e.version) {
        return { entry: e, conflict: true };
      }
      if (data.type !== undefined) e.type = data.type;
      if (data.priority !== undefined) e.priority = data.priority;
      if (data.content !== undefined) e.content = data.content;
      if (data.sceneName !== undefined) e.sceneName = data.sceneName;
      if (data.metadata !== undefined) e.metadata = data.metadata;
      e.version += 1;
      e.updatedAt = nowIso();
      return { entry: e, conflict: false };
    },
    deleteL1: async (actor, id, mode) => {
      const e = state.l1.get(id);
      if (!e) return false;
      if (actor.actor === "apiKey" && e.ownerApiKeyId !== actor.apiKeyId) return false;
      if (mode === "permanent") state.l1.delete(id);
      else e.deletedAt = nowIso();
      return true;
    },
    restoreL1: async (actor, id) => {
      const e = state.l1.get(id);
      if (!e) return null;
      if (actor.actor === "apiKey" && e.ownerApiKeyId !== actor.apiKeyId) return null;
      e.deletedAt = null;
      return e;
    },

    // L2
    createL2: async (actor, data) => {
      const owner = data.apiKeyId ?? actor.apiKeyId ?? "unknown";
      const id = `l2-${state.l2.size + 1}`;
      const entry: MemoryL2 = {
        id,
        ownerApiKeyId: owner,
        sessionId: data.sessionId ?? null,
        sourceId: data.sourceId ?? null,
        sceneName: data.sceneName ?? null,
        content: data.content,
        metadata: data.metadata,
        version: 1,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        deletedAt: null,
        errorCount: 0,
      };
      state.l2.set(id, entry);
      return entry;
    },
    listL2: async (actor, q) => {
      const page = q.page ?? 1;
      const limit = q.limit ?? 20;
      const owner = actor.actor === "apiKey" ? actor.apiKeyId : (q.apiKeyId ?? null);
      const items = Array.from(state.l2.values()).filter((e) => {
        if (owner && e.ownerApiKeyId !== owner) return false;
        if (q.includeDeleted === "active" && e.deletedAt) return false;
        if (q.includeDeleted === "deleted" && !e.deletedAt) return false;
        return true;
      });
      return paginate(items, page, limit);
    },
    getL2: async (actor, id) => {
      const e = state.l2.get(id) ?? null;
      if (!e) return null;
      if (actor.actor === "apiKey" && e.ownerApiKeyId !== actor.apiKeyId) return null;
      return e;
    },
    updateL2: async (actor, id, data) => {
      const e = state.l2.get(id);
      if (!e) throw new Error("not found");
      if (actor.actor === "apiKey" && e.ownerApiKeyId !== actor.apiKeyId)
        throw new Error("forbidden");
      if (data.content !== undefined) e.content = data.content;
      if (data.metadata !== undefined) e.metadata = data.metadata;
      e.version += 1;
      e.updatedAt = nowIso();
      return e;
    },
    deleteL2: async (actor, id, mode) => {
      const e = state.l2.get(id);
      if (!e) return false;
      if (actor.actor === "apiKey" && e.ownerApiKeyId !== actor.apiKeyId) return false;
      if (mode === "permanent") state.l2.delete(id);
      else e.deletedAt = nowIso();
      return true;
    },
    restoreL2: async (actor, id) => {
      const e = state.l2.get(id);
      if (!e) return null;
      if (actor.actor === "apiKey" && e.ownerApiKeyId !== actor.apiKeyId) return null;
      e.deletedAt = null;
      return e;
    },
    regenerateL2: async (actor, id) => {
      const e = state.l2.get(id);
      if (!e) throw new Error("not found");
      if (actor.actor === "apiKey" && e.ownerApiKeyId !== actor.apiKeyId)
        throw new Error("forbidden");
      if (e.errorCount >= 15) {
        const result: RegenerateEnqueueResult = {
          enqueued: 0,
          rejected: { reason: "error window exceeded", waitingWindowSec: 60 },
        };
        return result;
      }
      e.errorCount += 1;
      return { enqueued: 1 };
    },

    // L3
    listL3: async (actor, q) => {
      const page = q.page ?? 1;
      const limit = q.limit ?? 20;
      const owner = actor.actor === "apiKey" ? actor.apiKeyId : (q.apiKeyId ?? null);
      const items = Array.from(state.l3.values()).filter((e) => {
        if (owner && e.ownerApiKeyId !== owner) return false;
        if (q.includeDeleted === "active" && e.deletedAt) return false;
        if (q.includeDeleted === "deleted" && !e.deletedAt) return false;
        return true;
      });
      return paginate(items, page, limit);
    },
    getL3: async (actor, id) => {
      const e = state.l3.get(id) ?? null;
      if (!e) return null;
      if (actor.actor === "apiKey" && e.ownerApiKeyId !== actor.apiKeyId) return null;
      return e;
    },
    upsertL3: async (actor, data) => {
      const owner = data.apiKeyId ?? actor.apiKeyId ?? "unknown";
      const id = `l3-${state.l3.size + 1}`;
      const entry: MemoryL3 = {
        id,
        ownerApiKeyId: owner,
        sourceLayer: data.sourceLayer,
        sourceId: data.sourceId ?? null,
        content: data.content,
        metadata: data.metadata,
        version: 1,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        deletedAt: null,
      };
      state.l3.set(id, entry);
      return entry;
    },
    deleteL3: async (actor, id, mode) => {
      const e = state.l3.get(id);
      if (!e) return false;
      if (actor.actor === "apiKey" && e.ownerApiKeyId !== actor.apiKeyId) return false;
      if (mode === "permanent") state.l3.delete(id);
      else e.deletedAt = nowIso();
      return true;
    },
    restoreL3: async (actor, id) => {
      const e = state.l3.get(id);
      if (!e) return null;
      if (actor.actor === "apiKey" && e.ownerApiKeyId !== actor.apiKeyId) return null;
      e.deletedAt = null;
      return e;
    },
    regenerateL3: async () => ({ enqueued: 1 }),

    // Distillation
    getDistillationSelector: async (actor, apiKeyId) => {
      const owner = apiKeyId ?? actor.apiKeyId ?? null;
      if (owner && state.selectors.perKey.has(owner)) {
        return state.selectors.perKey.get(owner)!;
      }
      if (state.selectors.global) return state.selectors.global;
      return {
        provider: "auto",
        modelId: "auto",
        sourceLayer: "auto",
        apiKeyId: null,
        scope: null,
      };
    },
    setDistillationSelector: async (actor, data) => {
      const sel: DistillationSelector = {
        provider: data.provider,
        modelId: data.modelId,
        sourceLayer: data.scope === "self" ? "per-key" : "global",
        apiKeyId: data.scope === "self" ? (data.apiKeyId ?? actor.apiKeyId ?? null) : null,
        scope: data.scope,
      };
      if (data.scope === "global") {
        state.selectors.global = sel;
      } else if (data.apiKeyId) {
        state.selectors.perKey.set(data.apiKeyId, sel);
      }
      return sel;
    },
    deleteDistillationSelector: async (actor, scope, apiKeyId) => {
      if (scope === "global") {
        if (!state.selectors.global) return false;
        state.selectors.global = null;
        return true;
      }
      const owner = apiKeyId ?? actor.apiKeyId ?? null;
      if (!owner) return false;
      return state.selectors.perKey.delete(owner);
    },

    // DLQ
    listDistillationDlq: async (_actor, options) => {
      const entries = Array.from(state.dlq.values())
        .filter((e) => options.statuses.includes(e.status))
        .slice(0, options.limit);
      const counts: Record<string, number> = {};
      for (const e of state.dlq.values()) {
        counts[e.status] = (counts[e.status] ?? 0) + 1;
      }
      return { entries, statusCounts: counts };
    },
    retryDistillationDlq: async (actor, data) => {
      let retried = 0;
      let skipped = 0;
      for (const e of state.dlq.values()) {
        const matches = data.all ? true : (data.ids ?? []).includes(e.id);
        if (!matches) continue;
        if (e.status === "succeeded") {
          skipped++;
          continue;
        }
        e.status = "pending";
        retried++;
      }
      return { retried, skipped };
    },
  };
}

export function fakeAuditCapture(state: FakeState) {
  return async (input: {
    action: string;
    actor: AuthSubject;
    target: string;
    resourceType: string;
  }): Promise<void> => {
    state.audit.push({
      action: input.action,
      target: input.target,
      resourceType: input.resourceType,
    });
  };
}
