import { randomUUID } from "node:crypto";

import { getMemoryDbInstance } from "../core.ts";
import type {
  DistillationDLQEntry,
  DistillationLock,
  DistillationStore,
  DistillationTask,
  DistillationTaskKind,
  DistillationTaskResult,
  DistillationTaskStatus,
  DistillationUsageRecord,
  ClaimResult,
} from "../../distillation/store.ts";

import { applyDistillationResult } from "../../distillation/apply.ts";

const DEFAULT_LEASE_MS = 60_000;

export interface EnqueueDistillationTaskInput {
  kind: DistillationTaskKind;
  scope: string;
  payload: unknown;
  priority?: number;
  notBefore?: number;
  providerHint?: string | null;
  modelHint?: string | null;
  /** Coalesces mutable downstream work while it remains queued. */
  coalesceKey?: string | null;
  /** Mutable downstream work may either keep the earliest due time or reset debounce. */
  coalesceNotBefore?: "earliest" | "replace";
  /** Stable producer key. Re-enqueueing the same batch returns the existing task. */
  idempotencyKey?: string | null;
}

export interface PersistentDistillationDlqEntry extends DistillationDLQEntry {
  id: number;
  scope: string;
  status: "pending" | "running" | "failed" | "succeeded";
  retryCount: number;
  lastErrorCode: string | null;
}

interface TaskRow {
  task_id: string;
  kind: DistillationTaskKind;
  scope: string;
  payload_json: string;
  priority: number;
  attempt_count: number;
  not_before: number;
  status: DistillationTaskStatus;
  provider_hint: string | null;
  model_hint: string | null;
  last_error: string | null;
  version: number;
  result_json: string | null;
  fallback_evidence_json: string | null;
}

interface DlqRow {
  dlq_id: number;
  task_id: string;
  scope: string;
  reason: string;
  failure_kind: DistillationDLQEntry["failureKind"];
  attempts: number;
  error_message: string;
  recorded_at: number;
  retry_status: PersistentDistillationDlqEntry["status"];
  retry_count: number;
  last_error_code: string | null;
}

interface UsageRow {
  task_id: string;
  scope: string;
  kind: DistillationTaskKind;
  provider: string;
  model: string;
  tokens: number;
  usd: number;
  recorded_at: number;
}

function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function parseNullablePayload(raw: string | null): unknown | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function rowToTask(row: TaskRow): DistillationTask {
  return {
    id: row.task_id,
    kind: row.kind,
    scope: row.scope,
    payload: parsePayload(row.payload_json),
    priority: Number(row.priority),
    attempt: Number(row.attempt_count),
    notBefore: Number(row.not_before),
    status: row.status,
    providerHint: row.provider_hint,
    modelHint: row.model_hint,
    lastError: row.last_error,
    version: Number(row.version),
  };
}

function rowToDlq(row: DlqRow): PersistentDistillationDlqEntry {
  return {
    id: Number(row.dlq_id),
    taskId: row.task_id,
    scope: row.scope,
    reason: row.reason,
    failureKind: row.failure_kind,
    attempts: Number(row.attempts),
    error: row.error_message,
    recordedAt: Number(row.recorded_at),
    status: row.retry_status,
    retryCount: Number(row.retry_count),
    lastErrorCode: row.last_error_code,
  };
}

function rowToUsage(row: UsageRow): DistillationUsageRecord {
  return {
    taskId: row.task_id,
    scope: row.scope,
    kind: row.kind,
    provider: row.provider,
    model: row.model,
    tokens: Number(row.tokens),
    usd: Number(row.usd),
    recordedAt: Number(row.recorded_at),
  };
}

export function enqueueDistillationTask(input: EnqueueDistillationTaskInput): DistillationTask {
  const scope = input.scope.trim();
  if (!scope) throw new Error("[memory.distillation] scope is required");
  const idempotencyKey = input.idempotencyKey?.trim() || null;
  const coalesceKey = input.coalesceKey?.trim() || null;
  const db = getMemoryDbInstance();
  if (idempotencyKey) {
    const existing = db
      .prepare(
        `SELECT * FROM task_queue
         WHERE scope = ? AND kind = ? AND idempotency_key = ? AND deleted_at IS NULL`
      )
      .get(scope, input.kind, idempotencyKey) as TaskRow | undefined;
    if (existing) return rowToTask(existing);
  }
  const taskId = randomUUID();
  const now = Date.now();
  const priority = Math.min(10, Math.max(0, Math.floor(input.priority ?? 0)));
  const notBefore = Math.max(0, Math.floor(input.notBefore ?? now));
  if (coalesceKey) {
    const active = db
      .prepare(
        `SELECT * FROM task_queue
         WHERE scope = ? AND kind = ? AND coalesce_key = ?
           AND status IN ('claimed', 'running') AND deleted_at IS NULL
         ORDER BY updated_at DESC LIMIT 1`
      )
      .get(scope, input.kind, coalesceKey) as TaskRow | undefined;
    if (active) return rowToTask(active);

    const existing = db
      .prepare(
        `SELECT task_id FROM task_queue
         WHERE scope = ? AND kind = ? AND coalesce_key = ?
           AND status = 'queued' AND deleted_at IS NULL`
      )
      .get(scope, input.kind, coalesceKey) as { task_id: string } | undefined;
    if (existing) {
      const notBeforeExpression =
        input.coalesceNotBefore === "replace" ? "?" : "MIN(not_before, ?)";
      db.prepare(
        `UPDATE task_queue
         SET payload_json = ?, priority = MAX(priority, ?),
             not_before = ${notBeforeExpression}, provider_hint = ?, model_hint = ?,
             version = version + 1, updated_at = ?
         WHERE task_id = ? AND status = 'queued' AND deleted_at IS NULL`
      ).run(
        JSON.stringify(input.payload ?? {}),
        priority,
        notBefore,
        input.providerHint ?? null,
        input.modelHint ?? null,
        now,
        existing.task_id
      );
      return getDistillationTask(existing.task_id)!;
    }
  }
  db.prepare(
    `INSERT INTO task_queue (
      task_id, kind, scope, payload_json, priority, attempt_count,
      not_before, status, provider_hint, model_hint, idempotency_key, coalesce_key,
      last_error, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, 'queued', ?, ?, ?, ?, NULL, 1, ?, ?)`
  ).run(
    taskId,
    input.kind,
    scope,
    JSON.stringify(input.payload ?? {}),
    priority,
    notBefore,
    input.providerHint ?? null,
    input.modelHint ?? null,
    idempotencyKey,
    coalesceKey,
    now,
    now
  );
  return getDistillationTask(taskId)!;
}

export function getDistillationTask(taskId: string): DistillationTask | null {
  const row = getMemoryDbInstance()
    .prepare("SELECT * FROM task_queue WHERE task_id = ? AND deleted_at IS NULL")
    .get(taskId) as TaskRow | undefined;
  return row ? rowToTask(row) : null;
}

export function getDistillationTaskResult(taskId: string): DistillationTaskResult | null {
  const row = getMemoryDbInstance()
    .prepare(
      `SELECT result_json, fallback_evidence_json FROM task_queue
       WHERE task_id = ? AND status = 'succeeded' AND deleted_at IS NULL`
    )
    .get(taskId) as Pick<TaskRow, "result_json" | "fallback_evidence_json"> | undefined;
  if (!row) return null;
  const fallback = parseNullablePayload(row.fallback_evidence_json);
  return {
    payload: parseNullablePayload(row.result_json),
    fallbackEvidence: Array.isArray(fallback)
      ? fallback.filter((item): item is { kind: string; match: string } =>
          Boolean(
            item &&
            typeof item === "object" &&
            typeof (item as { kind?: unknown }).kind === "string" &&
            typeof (item as { match?: unknown }).match === "string"
          )
        )
      : [],
  };
}

export function listDistillationDlqEntries(
  options: {
    scope?: string;
    statuses?: PersistentDistillationDlqEntry["status"][];
    limit?: number;
  } = {}
): PersistentDistillationDlqEntry[] {
  const clauses: string[] = ["1 = 1"];
  const params: unknown[] = [];
  if (options.scope) {
    clauses.push("scope = ?");
    params.push(options.scope);
  }
  if (options.statuses?.length) {
    clauses.push(`retry_status IN (${options.statuses.map(() => "?").join(", ")})`);
    params.push(...options.statuses);
  }
  const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 100)));
  params.push(limit);
  const rows = getMemoryDbInstance()
    .prepare(
      `SELECT * FROM task_dlq WHERE ${clauses.join(" AND ")}
       ORDER BY recorded_at DESC, dlq_id DESC LIMIT ?`
    )
    .all(...params) as DlqRow[];
  return rows.map(rowToDlq);
}

export function getDistillationDlqStatusCounts(scope?: string): Record<string, number> {
  const params: unknown[] = [];
  let where = "";
  if (scope) {
    where = "WHERE scope = ?";
    params.push(scope);
  }
  const rows = getMemoryDbInstance()
    .prepare(
      `SELECT retry_status AS status, COUNT(*) AS count
       FROM task_dlq ${where}
       GROUP BY retry_status`
    )
    .all(...params) as Array<{ status: PersistentDistillationDlqEntry["status"]; count: number }>;
  const counts: Record<string, number> = {
    pending: 0,
    running: 0,
    failed: 0,
    succeeded: 0,
  };
  for (const row of rows) counts[row.status] = Number(row.count);
  return counts;
}

export function retryDistillationDlqEntries(
  ids: readonly number[],
  scope?: string
): {
  retried: number;
  skipped: number;
} {
  const uniqueIds = Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0)));
  const db = getMemoryDbInstance();
  let retried = 0;
  let skipped = 0;
  db.transaction(() => {
    for (const id of uniqueIds) {
      const params: unknown[] = [id];
      let scopeClause = "";
      if (scope) {
        scopeClause = "AND scope = ?";
        params.push(scope);
      }
      const entry = db
        .prepare(
          `SELECT task_id FROM task_dlq
           WHERE dlq_id = ? AND retry_status = 'pending' ${scopeClause}`
        )
        .get(...params) as { task_id: string } | undefined;
      if (!entry) {
        skipped++;
        continue;
      }
      const task = db
        .prepare(
          `UPDATE task_queue
           SET status = 'queued', attempt_count = 0, not_before = ?,
               last_error = NULL, claimed_by = NULL, lease_expires_at = NULL,
               version = version + 1, updated_at = ?
           WHERE task_id = ? AND status = 'failed_dlq' AND deleted_at IS NULL`
        )
        .run(Date.now(), Date.now(), entry.task_id);
      if (task.changes !== 1) {
        db.prepare(
          `UPDATE task_dlq SET retry_status = 'failed', retry_count = retry_count + 1,
             last_error_code = 'task_not_retryable' WHERE dlq_id = ?`
        ).run(id);
        skipped++;
        continue;
      }
      db.prepare(
        `UPDATE task_dlq SET retry_status = 'succeeded', retry_count = retry_count + 1,
           last_error_code = NULL WHERE dlq_id = ? AND retry_status = 'pending'`
      ).run(id);
      retried++;
    }
  })();
  return { retried, skipped };
}

export function listDistillationUsageRecords(
  options: { scope?: string; limit?: number } = {}
): DistillationUsageRecord[] {
  const params: unknown[] = [];
  let where = "";
  if (options.scope) {
    where = "WHERE scope = ?";
    params.push(options.scope);
  }
  const limit = Math.min(1000, Math.max(1, Math.floor(options.limit ?? 100)));
  params.push(limit);
  const rows = getMemoryDbInstance()
    .prepare(
      `SELECT task_id, scope, kind, provider, model, tokens, usd, recorded_at
       FROM distillation_usage ${where}
       ORDER BY recorded_at DESC, usage_id DESC LIMIT ?`
    )
    .all(...params) as UsageRow[];
  return rows.map(rowToUsage);
}

export interface DistillationResultApplier {
  (task: DistillationTask, result: DistillationTaskResult): void;
}

export interface CreateDistillationStoreOptions {
  applyResult?: DistillationResultApplier;
}

class SqliteDistillationStore implements DistillationStore {
  constructor(private readonly applyResult: DistillationResultApplier) {}

  async claimNextTask(now: number, scope: string | null): Promise<ClaimResult> {
    const db = getMemoryDbInstance();
    // Recover work abandoned by a crashed process after its lease expires.
    db.prepare(
      `UPDATE task_queue
       SET status = 'queued', claimed_by = NULL, lease_expires_at = NULL,
           version = version + 1, updated_at = ?
       WHERE status IN ('claimed', 'running')
         AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
         AND deleted_at IS NULL`
    ).run(now, now);

    const params: unknown[] = [now];
    let scopeClause = "";
    if (scope !== null) {
      scopeClause = "AND scope = ?";
      params.push(scope);
    }
    const row = db
      .prepare(
        `SELECT * FROM task_queue
         WHERE status = 'queued' AND not_before <= ? AND deleted_at IS NULL
         ${scopeClause}
         ORDER BY priority DESC, created_at ASC LIMIT 1`
      )
      .get(...params) as TaskRow | undefined;
    return { task: row ? rowToTask(row) : null, leaseMs: DEFAULT_LEASE_MS };
  }

  async markClaimed(
    taskId: string,
    expectedVersion: number,
    ownerId: string,
    leaseMs: number
  ): Promise<boolean> {
    const now = Date.now();
    const result = getMemoryDbInstance()
      .prepare(
        `UPDATE task_queue
         SET status = 'claimed', claimed_by = ?, lease_expires_at = ?,
             version = version + 1, updated_at = ?
         WHERE task_id = ? AND version = ? AND status = 'queued'
           AND deleted_at IS NULL`
      )
      .run(ownerId, now + Math.max(1, leaseMs), now, taskId, expectedVersion);
    return result.changes === 1;
  }

  async markRunning(taskId: string, ownerId: string): Promise<void> {
    getMemoryDbInstance()
      .prepare(
        `UPDATE task_queue SET status = 'running', version = version + 1, updated_at = ?
         WHERE task_id = ? AND claimed_by = ? AND status = 'claimed'`
      )
      .run(Date.now(), taskId, ownerId);
  }

  async renewTaskLease(taskId: string, ownerId: string, leaseMs: number): Promise<boolean> {
    const now = Date.now();
    const renewed = getMemoryDbInstance()
      .prepare(
        `UPDATE task_queue SET lease_expires_at = ?, updated_at = ?
         WHERE task_id = ? AND claimed_by = ? AND status IN ('claimed', 'running')
           AND deleted_at IS NULL`
      )
      .run(now + Math.max(1, leaseMs), now, taskId, ownerId);
    return renewed.changes === 1;
  }

  async completeTask(
    task: DistillationTask,
    ownerId: string,
    result: DistillationTaskResult,
    usage?: DistillationUsageRecord
  ): Promise<void> {
    const db = getMemoryDbInstance();
    db.transaction(() => {
      const claim = db
        .prepare(
          `SELECT task_id FROM task_queue
           WHERE task_id = ? AND claimed_by = ? AND status IN ('claimed', 'running')
             AND deleted_at IS NULL`
        )
        .get(task.id, ownerId) as { task_id: string } | undefined;
      if (!claim) {
        throw new Error(
          `[memory.distillation] claim ownership lost before completion: task=${task.id}`
        );
      }

      const completed = db
        .prepare(
          `UPDATE task_queue
           SET status = 'succeeded', last_error = NULL, claimed_by = NULL,
               lease_expires_at = NULL, result_json = ?, fallback_evidence_json = ?,
               version = version + 1, updated_at = ?
           WHERE task_id = ? AND claimed_by = ? AND status IN ('claimed', 'running')`
        )
        .run(
          JSON.stringify(result.payload ?? null),
          JSON.stringify(result.fallbackEvidence ?? []),
          Date.now(),
          task.id,
          ownerId
        );
      if (completed.changes !== 1) {
        throw new Error(
          `[memory.distillation] claim ownership lost during completion: task=${task.id}`
        );
      }
      this.applyResult(task, result);
      if (usage) {
        if (usage.taskId !== task.id || usage.scope !== task.scope || usage.kind !== task.kind) {
          throw new Error(`[memory.distillation] usage ownership mismatch: task=${task.id}`);
        }
        db.prepare(
          `INSERT INTO distillation_usage (
            task_id, scope, kind, provider, model, tokens, usd, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id) DO NOTHING`
        ).run(
          usage.taskId,
          usage.scope,
          usage.kind,
          usage.provider,
          usage.model,
          usage.tokens,
          usage.usd,
          usage.recordedAt
        );
      }
    })();
  }

  async markRetry(
    taskId: string,
    ownerId: string,
    nextAttempt: number,
    notBeforeMs: number,
    reason: string
  ): Promise<void> {
    getMemoryDbInstance()
      .prepare(
        `UPDATE task_queue
         SET status = 'queued', attempt_count = ?, not_before = ?, last_error = ?,
             claimed_by = NULL, lease_expires_at = NULL,
             version = version + 1, updated_at = ?
         WHERE task_id = ? AND claimed_by = ? AND status IN ('claimed', 'running')`
      )
      .run(nextAttempt, notBeforeMs, reason, Date.now(), taskId, ownerId);
  }

  async markDLQ(
    taskId: string,
    ownerId: string,
    reason: string,
    _failureKind: DistillationDLQEntry["failureKind"]
  ): Promise<void> {
    const db = getMemoryDbInstance();
    const claimed = db
      .prepare(
        `UPDATE task_queue
         SET status = 'failed_dlq', last_error = ?, claimed_by = NULL,
             lease_expires_at = NULL, version = version + 1, updated_at = ?
         WHERE task_id = ? AND claimed_by = ?
           AND status IN ('claimed', 'running')`
      )
      .run(reason, Date.now(), taskId, ownerId);
    if (claimed.changes === 0) {
      // Selection/executor-wiring failures can occur before the optimistic claim.
      db.prepare(
        `UPDATE task_queue
         SET status = 'failed_dlq', last_error = ?,
             version = version + 1, updated_at = ?
         WHERE task_id = ? AND status = 'queued'`
      ).run(reason, Date.now(), taskId);
    }
  }

  async moveToDLQ(taskId: string, ownerId: string, entry: DistillationDLQEntry): Promise<void> {
    const db = getMemoryDbInstance();
    db.transaction(() => {
      const transitioned = db
        .prepare(
          `UPDATE task_queue
           SET status = 'failed_dlq', last_error = ?, claimed_by = NULL,
               lease_expires_at = NULL, version = version + 1, updated_at = ?
           WHERE task_id = ? AND claimed_by = ?
             AND status IN ('claimed', 'running') AND deleted_at IS NULL`
        )
        .run(entry.error, Date.now(), taskId, ownerId);
      if (transitioned.changes !== 1) {
        throw new Error(
          `[memory.distillation] claim ownership lost before DLQ transition: task=${taskId}`
        );
      }
      db.prepare(
        `INSERT INTO task_dlq (
          task_id, scope, reason, failure_kind, attempts,
          error_message, recorded_at
        ) SELECT task_id, scope, ?, ?, ?, ?, ?
          FROM task_queue WHERE task_id = ?`
      ).run(entry.reason, entry.failureKind, entry.attempts, entry.error, entry.recordedAt, taskId);
    })();
  }

  async markSkippedBreaker(
    taskId: string,
    ownerId: string,
    notBeforeMs: number,
    reason: string
  ): Promise<void> {
    const db = getMemoryDbInstance();
    db.prepare(
      `UPDATE task_queue
       SET status = 'queued', not_before = MAX(not_before, ?), last_error = ?,
           claimed_by = NULL, lease_expires_at = NULL,
           version = version + 1, updated_at = ?
       WHERE task_id = ? AND (claimed_by IS NULL OR claimed_by = ?)`
    ).run(notBeforeMs, reason, Date.now(), taskId, ownerId);
  }

  async appendDLQ(entry: DistillationDLQEntry): Promise<void> {
    const db = getMemoryDbInstance();
    const task = db.prepare("SELECT scope FROM task_queue WHERE task_id = ?").get(entry.taskId) as
      { scope: string } | undefined;
    if (!task) throw new Error("[memory.distillation] DLQ task not found");
    db.prepare(
      `INSERT INTO task_dlq (
        task_id, scope, reason, failure_kind, attempts,
        error_message, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.taskId,
      task.scope,
      entry.reason,
      entry.failureKind,
      entry.attempts,
      entry.error,
      entry.recordedAt
    );
  }

  async acquireLock(
    scope: string,
    ownerId: string,
    ttlMs: number
  ): Promise<DistillationLock | null> {
    const db = getMemoryDbInstance();
    const now = Date.now();
    const expiresAt = now + Math.max(1, ttlMs);
    let acquired = false;
    db.transaction(() => {
      const existing = db
        .prepare("SELECT holder, expires_at FROM task_lock WHERE lock_key = ?")
        .get(scope) as { holder: string; expires_at: number } | undefined;
      if (existing && Number(existing.expires_at) > now && existing.holder !== ownerId) return;
      db.prepare(
        `INSERT INTO task_lock (lock_key, holder, acquired_at, expires_at, renewed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(lock_key) DO UPDATE SET
           holder = excluded.holder,
           acquired_at = CASE
             WHEN task_lock.holder = excluded.holder THEN task_lock.acquired_at
             ELSE excluded.acquired_at
           END,
           expires_at = excluded.expires_at,
           renewed_at = excluded.renewed_at`
      ).run(scope, ownerId, now, expiresAt, now);
      acquired = true;
    })();
    return acquired ? { ownerId, expiresAt } : null;
  }

  async releaseLock(scope: string, ownerId: string): Promise<void> {
    getMemoryDbInstance()
      .prepare("DELETE FROM task_lock WHERE lock_key = ? AND holder = ?")
      .run(scope, ownerId);
  }

  async recordUsage(record: DistillationUsageRecord): Promise<void> {
    getMemoryDbInstance()
      .prepare(
        `INSERT INTO distillation_usage (
          task_id, scope, kind, provider, model, tokens, usd, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO NOTHING`
      )
      .run(
        record.taskId,
        record.scope,
        record.kind,
        record.provider,
        record.model,
        record.tokens,
        record.usd,
        record.recordedAt
      );
  }

  async getQueueStats(): Promise<{ queued: number; running: number; dlq: number }> {
    const db = getMemoryDbInstance();
    const queue = db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
           SUM(CASE WHEN status IN ('claimed', 'running') THEN 1 ELSE 0 END) AS running
         FROM task_queue WHERE deleted_at IS NULL`
      )
      .get() as { queued: number | null; running: number | null } | undefined;
    const dlq = db.prepare("SELECT COUNT(*) AS count FROM task_dlq").get() as
      { count: number } | undefined;
    return {
      queued: Number(queue?.queued ?? 0),
      running: Number(queue?.running ?? 0),
      dlq: Number(dlq?.count ?? 0),
    };
  }
}

export function createDistillationStore(
  options: CreateDistillationStoreOptions = {}
): DistillationStore {
  // Force migration/bootstrap now so factory failures are visible at startup.
  getMemoryDbInstance();
  return new SqliteDistillationStore(
    options.applyResult ??
      ((task, result) => {
        applyDistillationResult(task, result, {
          enqueueTask: enqueueDistillationTask,
        });
      })
  );
}
