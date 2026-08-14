import {
  buildL0CaptureRecords,
  evaluateL0CaptureGate,
  scheduleL0Capture,
  shouldCaptureComboResult,
  type L0CaptureInputs,
  type L0MessageRecord,
  type L0MessageStore,
} from "./l0Capture.ts";
import {
  recordL0CaptureFailure,
  recordL0CaptureSuccess,
} from "../db/repositories/l0CaptureTelemetry.ts";
import { PRODUCTION_L1_TASK_ENQUEUER } from "./distillationQueue.ts";
import type { RecallProvider } from "../recall/facade.ts";
import type { Owner } from "../types.ts";

import { insertMessage } from "../l0.ts";
import { listMemories, searchMemories } from "../l1.ts";
import { listScenesOrderedByHeat } from "../l2.ts";
import { getActivePersona } from "../l3.ts";

const API_KEY_TEAM_ID = "omniroute";
const API_KEY_AGENT_ID = "api-key";

/**
 * Map the API-key owner used by the HTTP/chat surfaces into memory.db's
 * canonical three-part owner key. The fixed namespace segments ensure every
 * production adapter resolves the exact same partition without cross-DB joins.
 */
export function ownerFromApiKeyId(apiKeyId: string): Owner {
  const ownerId = apiKeyId.trim();
  if (!ownerId) throw new Error("[memory.runtime] apiKeyId is required");
  return {
    teamId: API_KEY_TEAM_ID,
    userId: ownerId,
    agentId: API_KEY_AGENT_ID,
  };
}

function recordSource(record: L0MessageRecord): "user" | "assistant" {
  return record.role;
}

const PRODUCTION_L0_STORE: L0MessageStore = {
  insert(record) {
    insertMessage({
      id: record.id,
      owner: ownerFromApiKeyId(record.ownerId),
      sessionKey: record.metadata.session_key || record.sessionId,
      sessionId: record.sessionId,
      role: record.role,
      content: record.content,
      source: recordSource(record),
      correlationId: record.metadata.correlation_id,
      comboExecutionKey: record.metadata.combo_execution_key,
      isInternal: record.metadata.is_internal,
      provider: record.metadata.provider,
      model: record.metadata.model,
      truncated: false,
      idempotencyKey: record.id,
      timestamp: record.metadata.timestamp || record.createdAt,
    });
  },
  insertMany(records) {
    for (const record of records) PRODUCTION_L0_STORE.insert(record);
  },
};

export function getProductionL0MessageStore(): L0MessageStore {
  return PRODUCTION_L0_STORE;
}

export function scheduleProductionL0Capture(
  input: L0CaptureInputs & {
    captureEnabled: boolean;
    isCombo: boolean;
    isFinalComboResult?: boolean;
    comboStepId: string | null;
    log?: { debug?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void } | null;
  }
): void {
  const gateInput = {
    ownerId: input.ownerId,
    isInternal: false,
    captureEnabled: input.captureEnabled,
    isCombo: input.isCombo,
    isFinalComboResult: input.isFinalComboResult,
    comboExecutionKey: input.comboExecutionKey,
    comboStepId: input.comboStepId,
  };
  const gate = evaluateL0CaptureGate(gateInput);
  const captureAllowed =
    gate.shouldCapture ||
    (gate.reason === "combo-subrequest-skipped" && shouldCaptureComboResult(gateInput));
  if (!captureAllowed) return;

  const records = buildL0CaptureRecords(input);
  if (records.length === 0) return;

  // Telemetry only records the captured attempt; the gate does NOT mark a
  // failure because "gate rejected" is a known intentional outcome.
  const ownerApiKeyId = input.ownerId;
  scheduleL0Capture(records, {
    store: PRODUCTION_L0_STORE,
    enqueueL1: PRODUCTION_L1_TASK_ENQUEUER,
    log: input.log,
    onSuccess: () => recordL0CaptureSuccess(ownerApiKeyId),
    onFailure: (category) => recordL0CaptureFailure(ownerApiKeyId, category),
  });
}

function readTags(metadata: Record<string, unknown>): string[] {
  const tags = metadata.tags;
  if (!Array.isArray(tags)) return [];
  return tags.filter((tag): tag is string => typeof tag === "string");
}

export const PRODUCTION_RECALL_PROVIDER: RecallProvider = {
  async fetchL3({ ownerId }) {
    const persona = getActivePersona(ownerFromApiKeyId(ownerId));
    if (!persona) return [];
    return [
      {
        id: persona.personaId,
        title: persona.promptMode === "code" ? "Code persona" : "Chat persona",
        content: persona.content,
      },
    ];
  },

  async fetchL2({ ownerId }) {
    return listScenesOrderedByHeat({ owner: ownerFromApiKeyId(ownerId) }).map((scene) => ({
      id: scene.id,
      title: scene.sceneName,
      summary: scene.summary,
    }));
  },

  async fetchL1({ ownerId, query }) {
    const owner = ownerFromApiKeyId(ownerId);
    const memories = query.trim() ? searchMemories({ owner, query }) : listMemories({ owner });
    return memories.map((memory) => ({
      id: memory.id,
      content: memory.content,
      score: null,
      tags: readTags(memory.metadata),
    }));
  },
};
