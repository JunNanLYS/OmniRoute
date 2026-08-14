/**
 * Memory API — dependency-injection registry.
 *
 * The route handlers are deliberately storage-agnostic. They call a
 * strongly-typed service interface (`MemoryFourLayerService`) and the
 * validation / task / audit helpers through this module. Tests can
 * `setFourLayerServiceForTesting(...)` and `setProviderModelValidator(...)`
 * to swap real storage for a stub without touching the route code.
 *
 * **Hard rules enforced here:**
 *  - Routes never import from `src/memory/db/*` (DB schema is owned by the
 *    TencentDB integration branch). The service contract is the boundary.
 *  - No raw SQL in route handlers.
 *  - Audit / task enqueue / provider-model validation are all DI'd so the
 *    unit tests can replace them with fakes.
 */
import { createFourLayerService } from "../db/service.ts";
import type { Owner } from "../types.ts";

import type {
  L0ListingQuery,
  L1ListingQuery,
  L2ListingQuery,
  L3ListingQuery,
  L0Import,
  L0DeleteBody,
  L0DeleteAll,
  L1Create,
  L1Update,
  L1DeleteBody,
  L2Create,
  L2Update,
  L2DeleteBody,
  L2Regenerate,
  L3Upsert,
  L3DeleteBody,
  L3Regenerate,
  DistillationPut,
  DistillationDlqRetry,
} from "@/shared/schemas/memoryFourLayer";

// ────────────────────────────── Domain entities ──────────────────────────────

export interface MemoryRequestScope {
  actor: AuthSubject;
  ownerApiKeyId: string;
  owner: Owner;
}

export interface MemoryServiceContext {
  actor: AuthSubject;
  ownerApiKeyId?: string;
  owner?: Owner;
}

export interface MemoryL0 {
  id: string;
  ownerApiKeyId: string;
  sessionKey: string;
  sessionId: string | null;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  recordedAt: string;
  source: "user" | "assistant" | "imported";
  correlationId: string | null;
  comboExecutionKey: string | null;
  isInternal: boolean;
  provider: string | null;
  model: string | null;
  truncated: boolean;
  idempotencyKey: string;
  deletedAt: string | null;
}

export interface MemoryL1 {
  id: string;
  ownerApiKeyId: string;
  type: L1Create["type"];
  priority: number;
  content: string;
  sceneName: string;
  metadata: Record<string, unknown>;
  sourceMessageIds: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  lastModifiedBy: "user" | "pipeline";
  editedByUser: boolean;
  deletedAt: string | null;
}

export interface MemoryL2 {
  id: string;
  ownerApiKeyId: string;
  sceneName: string;
  groupKey: string | null;
  summary: string;
  heat: number;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastModifiedBy: "user" | "pipeline";
  editedByUser: boolean;
  deletedAt: string | null;
}

export interface MemoryL3 {
  id: string;
  ownerApiKeyId: string;
  content: string;
  promptMode: "chat" | "code";
  version: number;
  createdAt: string;
  updatedAt: string;
  lastModifiedBy: "user" | "pipeline";
  editedByUser: boolean;
  deletedAt: string | null;
}

export interface DistillationSelector {
  provider: string;
  modelId: string;
  sourceLayer: "per-key" | "global" | "env" | "auto";
  apiKeyId: string | null;
  scope: "self" | "global" | null;
}

export interface DistillationDlqEntry {
  id: string;
  ownerApiKeyId: string;
  sourceLayer: "l0" | "l1" | "l2";
  sourceId: string | null;
  errorMessage: string;
  errorAt: string;
  retryCount: number;
  status: "pending" | "running" | "failed" | "succeeded";
  lastErrorCode: string | null;
}

export interface DistillationUsageRecord {
  id: number;
  ownerApiKeyId: string;
  kind: "L0_chunk_embed" | "L1_extract" | "L2_scene" | "L3_persona";
  provider: string;
  model: string;
  tokens: number;
  usd: number;
  recordedAt: string;
}

export interface DistillationUsageSummary {
  tokens: number;
  usd: number;
  tasks: number;
}

export interface ListDistillationUsageResult {
  records: DistillationUsageRecord[];
  totals: DistillationUsageSummary;
}

export interface ListResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export type MemoryListingQuery = {
  page?: number;
  limit?: number;
  offset?: number;
  apiKeyId?: string;
  includeDeleted?: "active" | "deleted" | "any";
};

export class MemoryOptimisticConflictError extends Error {
  constructor(message = "Memory optimistic version conflict") {
    super(message);
    this.name = "MemoryOptimisticConflictError";
  }
}

export interface RegenerateEnqueueResult {
  enqueued: number;
  /** When the call was rejected because the rolling error count exceeded the cap. */
  rejected?: { reason: string; waitingWindowSec: number };
}

// ────────────────────────────── Service interface ──────────────────────────────

/**
 * The strongly-typed storage contract. Every route handler depends on this
 * interface only. The production adapter lives under `src/memory/db/`; tests
 * can replace it through the dependency registry above.
 */
export interface MemoryFourLayerService {
  // L0
  importL0(scope: MemoryRequestScope, data: L0Import): Promise<{ importedIds: string[] }>;
  listL0(scope: MemoryRequestScope, query: L0ListingQuery): Promise<ListResult<MemoryL0>>;
  getL0(scope: MemoryRequestScope, id: string): Promise<MemoryL0 | null>;
  deleteL0(scope: MemoryRequestScope, id: string, mode: L0DeleteBody["mode"]): Promise<boolean>;
  deleteL0Session(
    scope: MemoryRequestScope,
    sessionId: string,
    mode: L0DeleteAll["mode"]
  ): Promise<{ deleted: number }>;
  restoreL0(scope: MemoryRequestScope, id: string): Promise<MemoryL0 | null>;

  // L1
  createL1(scope: MemoryRequestScope, data: L1Create): Promise<MemoryL1>;
  listL1(scope: MemoryRequestScope, query: L1ListingQuery): Promise<ListResult<MemoryL1>>;
  searchL1(scope: MemoryRequestScope, query: L1ListingQuery): Promise<ListResult<MemoryL1>>;
  getL1(scope: MemoryRequestScope, id: string): Promise<MemoryL1 | null>;
  updateL1(
    scope: MemoryRequestScope,
    id: string,
    data: L1Update
  ): Promise<{ entry: MemoryL1; conflict: boolean }>;
  deleteL1(scope: MemoryRequestScope, id: string, mode: L1DeleteBody["mode"]): Promise<boolean>;
  restoreL1(scope: MemoryRequestScope, id: string): Promise<MemoryL1 | null>;

  // L2
  createL2(scope: MemoryRequestScope, data: L2Create): Promise<MemoryL2>;
  listL2(scope: MemoryRequestScope, query: L2ListingQuery): Promise<ListResult<MemoryL2>>;
  getL2(scope: MemoryRequestScope, id: string): Promise<MemoryL2 | null>;
  updateL2(
    scope: MemoryRequestScope,
    id: string,
    data: L2Update
  ): Promise<{ entry: MemoryL2; conflict: boolean }>;
  deleteL2(scope: MemoryRequestScope, id: string, mode: L2DeleteBody["mode"]): Promise<boolean>;
  restoreL2(scope: MemoryRequestScope, id: string): Promise<MemoryL2 | null>;
  regenerateL2(
    scope: MemoryRequestScope,
    id: string,
    data: L2Regenerate
  ): Promise<RegenerateEnqueueResult>;

  // L3
  listL3(scope: MemoryRequestScope, query: L3ListingQuery): Promise<ListResult<MemoryL3>>;
  getL3(scope: MemoryRequestScope, id: string): Promise<MemoryL3 | null>;
  upsertL3(scope: MemoryRequestScope, data: L3Upsert): Promise<MemoryL3>;
  deleteL3(scope: MemoryRequestScope, id: string, mode: L3DeleteBody["mode"]): Promise<boolean>;
  restoreL3(scope: MemoryRequestScope, id: string): Promise<MemoryL3 | null>;
  regenerateL3(scope: MemoryRequestScope, data: L3Regenerate): Promise<RegenerateEnqueueResult>;

  // Distillation-model
  getDistillationSelector(
    context: MemoryServiceContext,
    apiKeyId?: string | null
  ): Promise<DistillationSelector>;
  setDistillationSelector(
    context: MemoryServiceContext,
    data: DistillationPut
  ): Promise<DistillationSelector>;
  deleteDistillationSelector(
    context: MemoryServiceContext,
    selectorScope: DistillationPut["scope"],
    apiKeyId?: string | null
  ): Promise<boolean>;

  // Distillation DLQ
  listDistillationDlq(
    scope: MemoryRequestScope,
    options: { limit: number; statuses: DistillationDlqEntry["status"][] }
  ): Promise<{ entries: DistillationDlqEntry[]; statusCounts: Record<string, number> }>;
  retryDistillationDlq(
    scope: MemoryRequestScope,
    data: DistillationDlqRetry
  ): Promise<{ retried: number; skipped: number }>;

  // Distillation usage (token + USD accounting)
  listDistillationUsage(
    scope: MemoryRequestScope,
    options: { limit: number }
  ): Promise<ListDistillationUsageResult>;

  // L0 capture telemetry — owner-scoped, masked aggregate counters.
  getL0CaptureStatus(scope: MemoryRequestScope): Promise<{
    ownerApiKeyId: string;
    successCount: number;
    failureCount: number;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastFailureCategory: string | null;
  }>;
}

// ────────────────────────────── Auth subject ──────────────────────────────

export interface AuthSubject {
  /** The API key ID the request authenticated as (always set for self scopes). */
  apiKeyId: string | null;
  /** Identity for the management dashboard session; absent for API-key callers. */
  userId: string | null;
  /** Source label — `apiKey`, `dashboard`, `cliToken`. */
  actor: "apiKey" | "dashboard" | "cliToken";
  /** True when the caller carries the `manage` scope. */
  isManagement: boolean;
  /** Bearer token (empty when caller is dashboard session). */
  apiKey: string;
}

// ────────────────────────────── Other dependencies ──────────────────────────────

export interface ProviderModelValidator {
  (input: {
    provider: string;
    modelId: string;
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface AuditWriter {
  (input: {
    action: string;
    actor: AuthSubject;
    target: string;
    resourceType: string;
    details?: unknown;
    request?: Request;
  }): Promise<void>;
}

export interface TaskEnqueuer {
  /** Enqueue a regeneration task. Returns the task id. */
  (input: {
    layer: "l2" | "l3";
    entryId: string;
    ownerApiKeyId: string;
    reason?: string;
  }): Promise<{ taskId: string }>;
}

// ────────────────────────────── Default no-op service ──────────────────────────────

class NotImplementedService implements MemoryFourLayerService {
  private fail(): never {
    throw new Error("memory four-layer storage not wired");
  }
  importL0(): Promise<{ importedIds: string[] }> {
    return this.fail();
  }
  listL0(): Promise<ListResult<MemoryL0>> {
    return this.fail();
  }
  getL0(): Promise<MemoryL0 | null> {
    return this.fail();
  }
  deleteL0(): Promise<boolean> {
    return this.fail();
  }
  deleteL0Session(): Promise<{ deleted: number }> {
    return this.fail();
  }
  restoreL0(): Promise<MemoryL0 | null> {
    return this.fail();
  }
  createL1(): Promise<MemoryL1> {
    return this.fail();
  }
  listL1(): Promise<ListResult<MemoryL1>> {
    return this.fail();
  }
  searchL1(): Promise<ListResult<MemoryL1>> {
    return this.fail();
  }
  getL1(): Promise<MemoryL1 | null> {
    return this.fail();
  }
  updateL1(): Promise<{ entry: MemoryL1; conflict: boolean }> {
    return this.fail();
  }
  deleteL1(): Promise<boolean> {
    return this.fail();
  }
  restoreL1(): Promise<MemoryL1 | null> {
    return this.fail();
  }
  createL2(): Promise<MemoryL2> {
    return this.fail();
  }
  listL2(): Promise<ListResult<MemoryL2>> {
    return this.fail();
  }
  getL2(): Promise<MemoryL2 | null> {
    return this.fail();
  }
  updateL2(): Promise<MemoryL2> {
    return this.fail();
  }
  deleteL2(): Promise<boolean> {
    return this.fail();
  }
  restoreL2(): Promise<MemoryL2 | null> {
    return this.fail();
  }
  regenerateL2(): Promise<RegenerateEnqueueResult> {
    return this.fail();
  }
  listL3(): Promise<ListResult<MemoryL3>> {
    return this.fail();
  }
  getL3(): Promise<MemoryL3 | null> {
    return this.fail();
  }
  upsertL3(): Promise<MemoryL3> {
    return this.fail();
  }
  deleteL3(): Promise<boolean> {
    return this.fail();
  }
  restoreL3(): Promise<MemoryL3 | null> {
    return this.fail();
  }
  regenerateL3(): Promise<RegenerateEnqueueResult> {
    return this.fail();
  }
  getDistillationSelector(): Promise<DistillationSelector> {
    return this.fail();
  }
  setDistillationSelector(): Promise<DistillationSelector> {
    return this.fail();
  }
  deleteDistillationSelector(): Promise<boolean> {
    return this.fail();
  }
  listDistillationDlq(): Promise<{
    entries: DistillationDlqEntry[];
    statusCounts: Record<string, number>;
  }> {
    return this.fail();
  }
  retryDistillationDlq(): Promise<{ retried: number; skipped: number }> {
    return this.fail();
  }
  listDistillationUsage(): Promise<ListDistillationUsageResult> {
    return this.fail();
  }
  getL0CaptureStatus(): Promise<{
    ownerApiKeyId: string;
    successCount: number;
    failureCount: number;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastFailureCategory: string | null;
  }> {
    return this.fail();
  }
}

// ────────────────────────────── Registry & defaults ──────────────────────────────

const _productionService = createFourLayerService();
let _service: MemoryFourLayerService = _productionService;
let _validator: ProviderModelValidator = defaultValidator;
let _audit: AuditWriter = defaultAuditWriter;
let _enqueuer: TaskEnqueuer = defaultTaskEnqueuer;

export function getFourLayerService(): MemoryFourLayerService {
  return _service;
}

export function setFourLayerServiceForTesting(svc: MemoryFourLayerService): void {
  _service = svc;
}

export function resetFourLayerServiceForTesting(): void {
  _service = _productionService;
}

export function getProviderModelValidator(): ProviderModelValidator {
  return _validator;
}

export function setProviderModelValidatorForTesting(v: ProviderModelValidator): void {
  _validator = v;
}

export function resetProviderModelValidatorForTesting(): void {
  _validator = defaultValidator;
}

export function getAuditWriter(): AuditWriter {
  return _audit;
}

export function setAuditWriterForTesting(w: AuditWriter): void {
  _audit = w;
}

export function resetAuditWriterForTesting(): void {
  _audit = defaultAuditWriter;
}

export function getTaskEnqueuer(): TaskEnqueuer {
  return _enqueuer;
}

export function setTaskEnqueuerForTesting(t: TaskEnqueuer): void {
  _enqueuer = t;
}

export function resetTaskEnqueuerForTesting(): void {
  _enqueuer = defaultTaskEnqueuer;
}

// ────────────────────────────── Default impls (best-effort) ──────────────────────────────

/**
 * Default validator — uses the synced-available-model table to verify that
 * the requested provider+model is actually configured AND has been synced.
 * If the DB helpers are unavailable (storage repo not yet wired), falls back
 * to a permissive `ok: true` so the API surface still works.
 */
async function defaultValidator(input: {
  provider: string;
  modelId: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const { getSyncedAvailableModelsByConnection } = await import(
      /* @vite-ignore */ "@/lib/db/models"
    );
    const rows = await getSyncedAvailableModelsByConnection(input.provider, { limit: 1000 });
    const ids = new Set<string>();
    for (const r of rows) {
      if (r.model) ids.add(r.model);
    }
    if (!ids.has(input.modelId)) {
      return { ok: false, reason: "model not in synced available catalog" };
    }
    return { ok: true };
  } catch {
    // Storage repo absent — accept the input during bootstrap.
    return { ok: true };
  }
}

async function defaultAuditWriter(input: {
  action: string;
  actor: AuthSubject;
  target: string;
  resourceType: string;
  details?: unknown;
  request?: Request;
}): Promise<void> {
  try {
    const { logAuditEvent } = await import(/* @vite-ignore */ "@/lib/compliance/index");
    logAuditEvent({
      action: input.action,
      actor: input.actor.userId || input.actor.apiKeyId || "anon",
      target: input.target,
      resourceType: input.resourceType,
      details: input.details,
      status: "success",
    });
  } catch {
    // Audit must never break the request.
  }
}

async function defaultTaskEnqueuer(): Promise<{ taskId: string }> {
  // The worker module lives on the storage branch. When absent, return a
  // synthetic id so the API surface still works.
  return { taskId: `pending-${Date.now()}` };
}

// ────────────────────────────── Helpers ──────────────────────────────

export function isNoOpService(): boolean {
  return _service instanceof NotImplementedService;
}
