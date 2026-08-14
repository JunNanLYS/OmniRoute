/**
 * src/memory/types.ts
 *
 * Standalone four-layer memory storage core — public type definitions.
 *
 * Four layers:
 *   L0: raw messages (immutable; insert-only; idempotent by key)
 *   L1: structured memories (7 types; versioned in-place updates)
 *   L2: scenes (max 15 active per owner; UPDATE>MERGE>CREATE primitives)
 *   L3: persona (singleton per owner; upsert/clear/restore/permanent-delete)
 *
 * Plus operations: task_queue (enqueue/claim/transition/retry/DLQ), task_lock (TTL),
 * memory_settings (key/value/versioned/soft-deletable), embedding metadata.
 *
 * IMPORTANT: every value class below is owned by `src/memory/*` modules. There is
 * no cross-DB join — every query filters by an `owner_key` derived locally from
 * `{teamId, userId, agentId}`. See `ownerKey()` in `src/memory/db/core.ts`.
 */

import type { SqliteAdapter } from "../lib/db/adapters/types";

// ──────────────── Owner ────────────────

export interface Owner {
  teamId: string;
  userId: string;
  agentId: string;
}

export function ownerKey(o: Owner): string {
  // Owner identity is `{teamId}:{userId}:{agentId}`. We do NOT join across DBs.
  return `${o.teamId}${o.userId}${o.agentId}`;
}

// ──────────────── L0: Messages ────────────────

export type MessageRole = "user" | "assistant";
export type MessageSource = "user" | "assistant" | "imported";

export interface L0Message {
  id: string;
  ownerKey: string;
  teamId: string;
  userId: string;
  agentId: string;
  sessionKey: string;
  sessionId: string | null;
  role: MessageRole;
  content: string;
  timestamp: string;
  recordedAt: string;
  source: MessageSource;
  correlationId: string | null;
  comboExecutionKey: string | null;
  isInternal: boolean;
  provider: string | null;
  model: string | null;
  truncated: boolean;
  deletedAt: string | null;
  /** Stable, idempotency-derived identifier (the unique key). */
  idempotencyKey: string;
}

export interface L0InsertInput {
  /** Internal capture may preserve its stable record id as the canonical row id. */
  id?: string;
  owner: Owner;
  sessionKey: string;
  sessionId: string | null;
  role: MessageRole;
  content: string;
  source: MessageSource;
  correlationId: string | null;
  comboExecutionKey: string | null;
  isInternal: boolean;
  provider: string | null;
  model: string | null;
  truncated: boolean;
  /** Required: dedupe key. Repeat inserts are no-ops. */
  idempotencyKey: string;
  /** Optional explicit timestamp (ISO-8601). Otherwise recorded at insertion. */
  timestamp?: string;
}

export interface L0ListFilter {
  owner: Owner;
  sessionId?: string;
  isInternal?: boolean;
  includeDeleted?: boolean;
}

export interface L0InsertResult {
  id: string;
  inserted: boolean;
}

// ──────────────── L1: Memories ────────────────

export const L1_TYPES = [
  "persona",
  "episodic",
  "instruction",
  "work_fact",
  "work_task",
  "work_method",
  "work_artifact",
] as const;

export type L1Type = (typeof L1_TYPES)[number];

export type MemoryPriority = number; // 0..100

export interface L1Memory {
  id: string;
  ownerKey: string;
  teamId: string;
  userId: string;
  agentId: string;
  type: L1Type;
  priority: MemoryPriority;
  sceneName: string;
  sourceMessageIds: string[];
  metadata: Record<string, unknown>;
  /** Stable identity for pipeline-owned records; null for user-created records. */
  pipelineKey: string | null;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastModifiedBy: "user" | "pipeline";
  editedByUser: boolean;
  deletedAt: string | null;
  tombstone: boolean;
}

export interface L1CreateInput {
  owner: Owner;
  type: L1Type;
  priority: MemoryPriority;
  sceneName: string;
  sourceMessageIds: string[];
  metadata: Record<string, unknown>;
  pipelineKey?: string | null;
  content: string;
  lastModifiedBy: "user" | "pipeline";
  editedByUser: boolean;
}

export interface L1UpdateInput {
  content?: string;
  priority?: MemoryPriority;
  sceneName?: string;
  sourceMessageIds?: string[];
  metadata?: Record<string, unknown>;
  pipelineKey?: string | null;
  lastModifiedBy?: "user" | "pipeline";
  editedByUser?: boolean;
}

export interface L1ListFilter {
  owner: Owner;
  type?: L1Type;
  sceneName?: string;
  includeDeleted?: boolean;
}

// ──────────────── L2: Scenes ────────────────

export const L2_MAX_ACTIVE_PER_OWNER = 15;

export interface L2Scene {
  id: string;
  ownerKey: string;
  teamId: string;
  userId: string;
  agentId: string;
  sceneName: string;
  groupKey: string | null;
  summary: string;
  heat: number;
  content: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  lastModifiedBy: "user" | "pipeline";
  editedByUser: boolean;
  deletedAt: string | null;
}

export interface L2CreateInput {
  owner: Owner;
  sceneName: string;
  groupKey?: string | null;
  summary: string;
  heat: number;
  content: string;
  lastModifiedBy: "user" | "pipeline";
  editedByUser: boolean;
}

export interface L2UpsertInput {
  owner: Owner;
  sceneName: string;
  groupKey: string | null;
  summary: string;
  heat: number;
  content: string;
  /** When true, resulting heat = avg(current, input). */
  mergeHeat?: boolean;
  lastModifiedBy: "user" | "pipeline";
  editedByUser: boolean;
}

export interface L2UpsertResult {
  scene: L2Scene;
  created: boolean;
}

export interface L2ListFilter {
  owner: Owner;
  includeDeleted?: boolean;
}

// ──────────────── L3: Persona ────────────────

export type PromptMode = "chat" | "code";

export interface L3Persona {
  personaId: string;
  ownerKey: string;
  teamId: string;
  userId: string;
  agentId: string;
  content: string;
  promptMode: PromptMode;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastModifiedBy: "user" | "pipeline";
  editedByUser: boolean;
  deletedAt: string | null;
}

export interface L3UpsertInput {
  owner: Owner;
  content: string;
  promptMode: PromptMode;
  lastModifiedBy: "user" | "pipeline";
  editedByUser: boolean;
}

export interface L3GetFilter {
  includeDeleted?: boolean;
}

// ──────────────── Operations ────────────────

export type TaskStatus = "pending" | "running" | "done" | "failed" | "dlq";
export type TaskKind = "extract" | "summarize" | "embed" | "reindex" | "custom";

export const TASK_DLQ_ERROR_CLASSES = [
  "transient",
  "timeout",
  "rate_limit",
  "upstream_5xx",
  "validation",
  "permission_denied",
  "model_unset",
  "credentials_invalid",
  "unknown",
] as const;

export type TaskDlqErrorClass = (typeof TASK_DLQ_ERROR_CLASSES)[number];

export interface TaskQueueRow {
  taskId: string;
  ownerKey: string;
  teamId: string;
  userId: string;
  agentId: string;
  kind: TaskKind;
  payload: Record<string, unknown>;
  status: TaskStatus;
  attempts: number;
  maxAttempts: number;
  claimedBy: string | null;
  lastErrorClass: TaskDlqErrorClass | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface EnqueueTaskInput {
  owner: Owner;
  kind: TaskKind;
  payload: Record<string, unknown>;
  maxAttempts?: number;
}

export interface TransitionInput {
  errorClass?: TaskDlqErrorClass;
  errorMessage?: string;
}

export interface TaskLock {
  ownerKey: string;
  key: string;
  acquiredBy: string;
  expiresAt: string;
}

export interface AcquireLockInput {
  owner: Owner;
  key: string;
  ttlMs: number;
  acquiredBy?: string;
}

export interface AcquireLockResult {
  acquired: boolean;
  expiresAt: string | null;
}

export interface MemorySetting {
  key: string;
  value: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface EmbeddingMeta {
  signature: string | null;
  activeDim: number | null;
  source: string | null;
  vecLoaded: boolean;
  updatedAt: string;
}

// ──────────────── Vector store ────────────────

/**
 * Optional best-effort vector store. Returns null when sqlite-vec is unavailable
 * or VECTOR_STORE_DISABLE_VEC=true. FTS5 must always work as the authoritative path.
 */
export interface MemoryVectorStore {
  ensureReady(args: { signature: string; dim: number }): { ready: boolean; reason: string };
  upsertVector(args: { rowid: number; vector: Float32Array }): void;
  deleteVector(args: { rowid: number }): void;
  searchVector(args: { vector: Float32Array; topK: number; ownerKey: string }): Array<{
    rowid: number;
    distance: number;
    score: number;
  }>;
}

// ──────────────── DB handle re-export ────────────────

/** Re-export the SqliteAdapter contract so the memory module doesn't import from `src/lib/db` at use-sites. */
export type MemorySqliteAdapter = SqliteAdapter;
