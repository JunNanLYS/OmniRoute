/**
 * DistillationStore — the persistence seam the worker talks to.
 *
 * IMPORTANT: this module intentionally does NOT import from `@/memory/db/*`.
 * The repository is owned by another agent, so the contract here is the
 * single integration point. The default factory (`createDefaultDistillationStore`)
 * uses dynamic imports so a missing/partial repository implementation
 * surfaces as a structured error at first use, not at module load — so
 * the worker's tests + lifecycle stay isolated from the storage layer.
 *
 * Every method below returns a Promise; consumers MUST treat thrown errors
 * as terminal (no auto-retry inside the store). The worker classifies errors
 * and decides retry/DLQ.
 */

export type DistillationTaskKind = "L0_chunk_embed" | "L1_extract" | "L2_scene" | "L3_persona";

export type DistillationTaskStatus =
  | "queued"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed_retry"
  | "failed_dlq"
  | "skipped_breaker";

export interface DistillationTask {
  /** Repository-assigned stable id. */
  id: string;
  kind: DistillationTaskKind;
  /** Scope partition — usually apiKeyId; "global" means operator-wide. */
  scope: string;
  /** Free-form payload (chunk text, conversation slice, persona target, etc). */
  payload: unknown;
  priority: number;
  /** Monotonically increasing retry counter (set by worker; 0 = first attempt). */
  attempt: number;
  /** Earliest time the worker is allowed to claim this task (epoch ms). */
  notBefore: number;
  /** Last-known state — worker re-reads before claiming for the optimistic guard. */
  status: DistillationTaskStatus;
  /** Optional explicit provider/model hint. null = use selector chain. */
  providerHint: string | null;
  modelHint: string | null;
  /** Free-form diagnostics from the previous attempt (already sanitized). */
  lastError: string | null;
  /** Generation counter — bumped on every claim; used for optimistic transitions. */
  version: number;
}

export interface DistillationTaskResult {
  payload: unknown;
  fallbackEvidence: Array<{ kind: string; match: string }>;
}

export interface DistillationUsageRecord {
  taskId: string;
  scope: string;
  kind: DistillationTaskKind;
  provider: string;
  model: string;
  /** Total tokens billed (prompt + completion). USD is recorded separately. */
  tokens: number;
  usd: number;
  recordedAt: number;
}

export interface DistillationDLQEntry {
  taskId: string;
  reason: string;
  failureKind:
    | "retry_exhausted"
    | "no_retry"
    | "model_lockout"
    | "parse_failed"
    | "semantic_invalid"
    | "budget_exceeded"
    | "model_unset"
    | "model_deleted"
    | "credentials_invalid";
  attempts: number;
  /** Sanitized error message — never raw upstream text/stack. */
  error: string;
  recordedAt: number;
}

export interface DistillationLock {
  /** Process-local owner id (e.g. pid + uuid). */
  ownerId: string;
  /** Absolute expiry (epoch ms). */
  expiresAt: number;
}

export interface ClaimResult {
  /** null = no task available; leaseMs MUST be honoured by the caller. */
  task: DistillationTask | null;
  /** Lease duration; the worker MUST renew within this window or release. */
  leaseMs: number;
}

export interface DistillationStore {
  // ── Queue polling & lifecycle ─────────────────────────────────────────
  /** Highest-priority task whose `notBefore <= now` and `status === 'queued'`.
   *  Returns `task: null` when the queue is empty. */
  claimNextTask(now: number, scope: string | null): Promise<ClaimResult>;

  /** Optimistic transition queued → claimed using `version`. Returns false
   *  when another worker already advanced the row. */
  markClaimed(
    taskId: string,
    expectedVersion: number,
    ownerId: string,
    leaseMs: number
  ): Promise<boolean>;

  markRunning(taskId: string, ownerId: string): Promise<void>;
  /** Extend the claimed/running task lease while long model calls are in flight. */
  renewTaskLease(taskId: string, ownerId: string, leaseMs: number): Promise<boolean>;
  /** Apply the structured result and transition to succeeded as one storage commit. */
  completeTask(
    task: DistillationTask,
    ownerId: string,
    result: DistillationTaskResult,
    usage?: DistillationUsageRecord
  ): Promise<void>;
  markRetry(
    taskId: string,
    ownerId: string,
    nextAttempt: number,
    notBeforeMs: number,
    reason: string
  ): Promise<void>;
  markDLQ(
    taskId: string,
    ownerId: string,
    reason: string,
    failureKind: DistillationDLQEntry["failureKind"]
  ): Promise<void>;
  moveToDLQ(taskId: string, ownerId: string, entry: DistillationDLQEntry): Promise<void>;
  markSkippedBreaker(
    taskId: string,
    ownerId: string,
    notBeforeMs: number,
    reason: string
  ): Promise<void>;

  // ── Failure accounting ───────────────────────────────────────────────
  appendDLQ(entry: DistillationDLQEntry): Promise<void>;

  // ── Owner-level mutual exclusion ────────────────────────────────────
  /** Acquire / renew the per-scope distillation lock. Returns the active
   *  lock; when another process holds it and the lease is still valid,
   *  the holder is returned unchanged so the caller can decide. */
  acquireLock(scope: string, ownerId: string, ttlMs: number): Promise<DistillationLock | null>;
  releaseLock(scope: string, ownerId: string): Promise<void>;

  // ── Usage accounting ────────────────────────────────────────────────
  recordUsage(record: DistillationUsageRecord): Promise<void>;

  // ── Diagnostics ─────────────────────────────────────────────────────
  /** Counts of queued tasks by kind (used by the boot health snapshot). */
  getQueueStats(): Promise<{ queued: number; running: number; dlq: number }>;
}

/**
 * In-memory implementation used by tests AND as the dev-mode fallback when
 * the repository owner has not yet shipped their adapter. Every call is a
 * structured Promise so the worker does not branch on storage backend.
 */
export class InMemoryDistillationStore implements DistillationStore {
  private readonly tasks = new Map<string, DistillationTask>();
  private readonly dlq: DistillationDLQEntry[] = [];
  private readonly usage: DistillationUsageRecord[] = [];
  private readonly results = new Map<string, DistillationTaskResult>();
  private readonly locks = new Map<string, DistillationLock>();

  /** Test helper. */
  seed(tasks: DistillationTask[]): void {
    for (const t of tasks) this.tasks.set(t.id, { ...t });
  }

  /** Test helper. */
  snapshot(): {
    tasks: DistillationTask[];
    dlq: DistillationDLQEntry[];
    usage: DistillationUsageRecord[];
    results: Array<{ taskId: string; result: DistillationTaskResult }>;
  } {
    return {
      tasks: Array.from(this.tasks.values()).map((t) => ({ ...t })),
      dlq: [...this.dlq],
      usage: [...this.usage],
      results: Array.from(this.results, ([taskId, result]) => ({ taskId, result })),
    };
  }

  async claimNextTask(now: number, scope: string | null): Promise<ClaimResult> {
    let best: DistillationTask | null = null;
    for (const t of this.tasks.values()) {
      if (t.status !== "queued") continue;
      if (t.notBefore > now) continue;
      if (scope !== null && t.scope !== scope) continue;
      if (best === null || t.priority > best.priority) best = t;
    }
    if (!best) return { task: null, leaseMs: 60_000 };
    return { task: { ...best }, leaseMs: 60_000 };
  }

  async markClaimed(
    taskId: string,
    expectedVersion: number,
    ownerId: string,
    leaseMs: number
  ): Promise<boolean> {
    const t = this.tasks.get(taskId);
    if (!t) return false;
    if (t.version !== expectedVersion) return false;
    if (t.status !== "queued") return false;
    t.status = "claimed";
    t.version += 1;
    void ownerId;
    void leaseMs;
    return true;
  }

  async markRunning(taskId: string, _ownerId: string): Promise<void> {
    const t = this.tasks.get(taskId);
    if (!t) return;
    t.status = "running";
    t.version += 1;
  }

  async renewTaskLease(taskId: string, _ownerId: string, _leaseMs: number): Promise<boolean> {
    const task = this.tasks.get(taskId);
    return task?.status === "claimed" || task?.status === "running";
  }

  async completeTask(
    task: DistillationTask,
    _ownerId: string,
    result: DistillationTaskResult,
    usage?: DistillationUsageRecord
  ): Promise<void> {
    const current = this.tasks.get(task.id);
    if (!current) throw new Error(`[memory.distillation] task not found: ${task.id}`);
    if (current.status !== "claimed" && current.status !== "running") {
      throw new Error(`[memory.distillation] task is not claimed: ${task.id}`);
    }
    current.status = "succeeded";
    current.lastError = null;
    current.version += 1;
    this.results.set(task.id, result);
    if (usage) this.recordUsageOnce(usage);
  }

  async markRetry(
    taskId: string,
    _ownerId: string,
    nextAttempt: number,
    notBeforeMs: number,
    reason: string
  ): Promise<void> {
    const t = this.tasks.get(taskId);
    if (!t) return;
    t.status = "queued";
    t.attempt = nextAttempt;
    t.notBefore = notBeforeMs;
    t.lastError = reason;
    t.version += 1;
  }

  async markDLQ(
    taskId: string,
    _ownerId: string,
    reason: string,
    _failureKind: DistillationDLQEntry["failureKind"]
  ): Promise<void> {
    const t = this.tasks.get(taskId);
    if (!t) return;
    t.status = "failed_dlq";
    t.lastError = reason;
    t.version += 1;
  }

  async moveToDLQ(taskId: string, ownerId: string, entry: DistillationDLQEntry): Promise<void> {
    await this.markDLQ(taskId, ownerId, entry.error, entry.failureKind);
    await this.appendDLQ(entry);
  }

  async markSkippedBreaker(
    taskId: string,
    _ownerId: string,
    notBeforeMs: number,
    _reason: string
  ): Promise<void> {
    const t = this.tasks.get(taskId);
    if (!t) return;
    // leave queued so the next tick re-polls — but push notBefore into the future
    // so the same task is not re-claimed until the breaker can recover.
    t.notBefore = Math.max(t.notBefore, notBeforeMs);
    t.status = "queued";
    t.version += 1;
  }

  async appendDLQ(entry: DistillationDLQEntry): Promise<void> {
    this.dlq.push(entry);
  }

  async acquireLock(
    scope: string,
    ownerId: string,
    ttlMs: number
  ): Promise<DistillationLock | null> {
    const now = Date.now();
    const existing = this.locks.get(scope);
    if (existing && existing.expiresAt > now && existing.ownerId !== ownerId) {
      return null;
    }
    const next: DistillationLock = { ownerId, expiresAt: now + ttlMs };
    this.locks.set(scope, next);
    return next;
  }

  async releaseLock(scope: string, ownerId: string): Promise<void> {
    const existing = this.locks.get(scope);
    if (existing && existing.ownerId === ownerId) this.locks.delete(scope);
  }

  async recordUsage(record: DistillationUsageRecord): Promise<void> {
    this.recordUsageOnce(record);
  }

  private recordUsageOnce(record: DistillationUsageRecord): void {
    if (this.usage.some((existing) => existing.taskId === record.taskId)) return;
    this.usage.push(record);
  }

  async getQueueStats(): Promise<{ queued: number; running: number; dlq: number }> {
    let queued = 0;
    let running = 0;
    for (const t of this.tasks.values()) {
      if (t.status === "queued") queued++;
      else if (t.status === "running" || t.status === "claimed") running++;
    }
    return { queued, running, dlq: this.dlq.length };
  }
}

/**
 * Default production-store factory. The worker is restart-recoverable by
 * contract, so production must never silently fall back to process memory.
 * Tests that need an ephemeral store instantiate `InMemoryDistillationStore`
 * explicitly.
 */
export interface DistillationStoreUnavailableError extends Error {
  readonly code: "DISTILLATION_STORE_UNAVAILABLE";
}

export function makeStoreUnavailable(message: string): DistillationStoreUnavailableError {
  const e = new Error(message) as DistillationStoreUnavailableError & { code?: string };
  e.name = "DistillationStoreUnavailableError";
  e.code = "DISTILLATION_STORE_UNAVAILABLE";
  return e as DistillationStoreUnavailableError;
}

/**
 * Construct the default store. Tries (in order):
 *   1. `await import("@/memory/db/repositories/distillation").then(...)` — the
 *      anticipated path the repository agent will ship.
 *   2. `await import("@/memory/db/tasks/settings")` — fallback path if the
 *      repository exposes a flat factory at the older namespace.
 *   3. In-memory adapter — dev/test fallback.
 *
 * The function is intentionally tolerant: a missing module is not a fatal
 * error during boot; the worker just stays idle until the storage layer
 * becomes available.
 */
export async function createDefaultDistillationStore(): Promise<DistillationStore> {
  try {
    const mod = (await import("@/memory/db/repositories/distillation.ts" as string)) as {
      createDistillationStore?: () => Promise<DistillationStore> | DistillationStore;
    };
    if (typeof mod.createDistillationStore !== "function") {
      throw makeStoreUnavailable("Persistent distillation store factory is missing");
    }
    const store = await mod.createDistillationStore();
    if (!store) throw makeStoreUnavailable("Persistent distillation store factory returned empty");
    return store;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: unknown }).code === "DISTILLATION_STORE_UNAVAILABLE"
    ) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw makeStoreUnavailable(`Persistent distillation store unavailable: ${message}`);
  }
}

/** Test-only helper to wipe global state — never used in production. */
export function __resetDistillationStoreState(): void {
  if (typeof globalThis !== "undefined") {
    delete globalThis.__omnirouteDistillationSecret;
  }
}
