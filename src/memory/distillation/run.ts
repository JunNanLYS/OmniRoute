/**
 * Explicit distillation run — the evaluation control plane.
 *
 * `POST /api/memory/distillation/run` starts a run that executes the selected
 * layers sequentially (L1 → L2 → L3) for one session/owner:
 *
 *   - each layer drains its queue before the next layer begins;
 *   - L1 failure marks L2/L3 `skipped`; L2 failure marks L3 `skipped`;
 *   - a task failure is terminal: the task moves to the DLQ with sanitized
 *     evidence and is NEVER retried inside the run — a rerun mints a new
 *     run id;
 *   - queued work for the layer is expedited to "due now" so background
 *     debounce cadences (L1 idle window, L2 scene debounce) do not stall
 *     the run — the background worker's scheduling is untouched;
 *   - when `l3` is selected, the L3 persona task is force-enqueued after L2
 *     completes (the background `scheduleL3` gating cannot suppress it).
 *
 * The run reuses the production seams — the same store claim/lease protocol,
 * selector chain, executor adapter, handlers, and apply pipeline — instead of
 * routing provider calls a second time. It deliberately does NOT use the
 * background worker singleton: runs are request-scoped orchestrations over
 * the same queue.
 */

import { randomUUID } from "node:crypto";

import { resolveDistillationConfig } from "./config.ts";
import type { DistillationStore, DistillationTask, DistillationTaskKind } from "./store.ts";
import {
  resolveDistillationSelection,
  validateModelStillUsable,
  type CatalogSnapshot,
  type SelectorDeps,
} from "./selector.ts";
import { classifyFailure, sanitizeMessage } from "./failure.ts";
import { signInternalMarker } from "./internalMarker.ts";
import { buildUsageRecord } from "./usage.ts";
import { DEFAULT_HANDLERS } from "./handlers.ts";
import { executeDistillationTask, type ExecutorDeps } from "./executor.ts";
import type { HandlerCallArgs, HandlerOutcome } from "./handlers.ts";
import type { EnqueueInput } from "./apply.ts";

export type DistillationRunLayer = "l1" | "l2" | "l3";
export type DistillationRunStatus = "running" | "succeeded" | "failed";
export type DistillationRunLayerStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export interface DistillationRunLayerState {
  layer: DistillationRunLayer;
  status: DistillationRunLayerStatus;
  taskIds: string[];
  error: { kind: string; message: string } | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface DistillationRunEvidenceTask {
  id: string;
  kind: string;
  status: string;
  lastError: string | null;
}

export interface DistillationRunEvidenceDlq {
  taskId: string;
  reason: string;
  failureKind: string;
  error: string;
  recordedAt: number;
}

export interface DistillationRunEvidence {
  tasks: DistillationRunEvidenceTask[];
  dlq: DistillationRunEvidenceDlq[];
}

export interface DistillationRunRecord {
  runId: string;
  ownerApiKeyId: string;
  session: string;
  /** Selected layers in canonical execution order. */
  layers: DistillationRunLayer[];
  layerTimeoutMs: number;
  status: DistillationRunStatus;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  layerStates: DistillationRunLayerState[];
  /** Task/DLQ evidence — populated when the run reaches a terminal state. */
  evidence: DistillationRunEvidence | null;
}

/** Layer → queue kinds executed during that layer's phase. */
const LAYER_KINDS: Record<DistillationRunLayer, readonly DistillationTaskKind[]> = {
  l1: ["L1_extract"],
  l2: ["L2_scene"],
  l3: ["L3_persona"],
};

const CANONICAL_LAYER_ORDER: readonly DistillationRunLayer[] = ["l1", "l2", "l3"];

/** Safety valve — a layer never executes more tasks than this in one run. */
const MAX_TASKS_PER_LAYER = 500;
/** Owner-lock TTL while a run task is executing (mirrors the worker's window). */
const RUN_LOCK_TTL_MS = 240_000;
const REGISTRY_MAX_ENTRIES = 200;

export type RunHandler = (args: HandlerCallArgs) => Promise<HandlerOutcome>;

export interface DistillationRunDeps {
  store: DistillationStore;
  executor: ExecutorDeps;
  selector: SelectorDeps;
  handlers: Partial<Record<DistillationTaskKind, RunHandler>>;
  enqueueTask(input: EnqueueInput): unknown;
  planL1Task(input: {
    scope: string;
    sessionId: string;
    correlationId: string | null;
    capturedAt: string;
    now?: number;
  }): (EnqueueInput & { coalesceKey: string; coalesceNotBefore: "earliest" | "replace" }) | null;
  expediteQueuedTasks(scope: string, kinds: readonly DistillationTaskKind[], now: number): number;
  listTasks(options: {
    scope?: string;
    kinds?: DistillationTaskKind[];
    limit?: number;
  }): DistillationTask[];
  listDlqEntries(options: { scope?: string; limit?: number }): Array<{
    taskId: string;
    reason: string;
    failureKind: string;
    error: string;
    recordedAt: number;
  }>;
  buildL3Task(scope: string): EnqueueInput | null;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface StartDistillationRunInput {
  ownerApiKeyId: string;
  session: string;
  layers: readonly DistillationRunLayer[];
  layerTimeoutMs: number;
}

interface RunRegistryEntry {
  record: DistillationRunRecord;
  done: Promise<void>;
}

declare global {
  var __omnirouteDistillationRuns: Map<string, RunRegistryEntry> | undefined;
}

function registry(): Map<string, RunRegistryEntry> {
  if (!globalThis.__omnirouteDistillationRuns) {
    globalThis.__omnirouteDistillationRuns = new Map();
  }
  return globalThis.__omnirouteDistillationRuns;
}

function pruneRegistry(map: Map<string, RunRegistryEntry>): void {
  if (map.size <= REGISTRY_MAX_ENTRIES) return;
  for (const [key, entry] of map) {
    if (map.size <= REGISTRY_MAX_ENTRIES) break;
    if (entry.record.status !== "running") map.delete(key);
  }
}

// ────────────────────────────── DI seam ──────────────────────────────

type DistillationRunDepsFactory = () => Promise<DistillationRunDeps> | DistillationRunDeps;

let _depsFactoryForTests: DistillationRunDepsFactory | null = null;

/** Test-only — replace the production dependency factory. */
export function setDistillationRunDepsForTesting(factory: DistillationRunDepsFactory): void {
  _depsFactoryForTests = factory;
}

/** Test-only — restore the production dependency factory. */
export function resetDistillationRunDepsForTesting(): void {
  _depsFactoryForTests = null;
}

async function resolveRunDeps(): Promise<DistillationRunDeps> {
  if (_depsFactoryForTests) return await _depsFactoryForTests();
  return createProductionDistillationRunDeps();
}

/**
 * Production wiring — the same store, selector, executor, and scheduling
 * seams the background worker uses. Dynamic imports keep this module's load
 * graph free of DB adapters (mirrors `createDefaultDistillationStore`).
 */
export async function createProductionDistillationRunDeps(): Promise<DistillationRunDeps> {
  const [repo, runtime] = await Promise.all([
    import("../db/repositories/distillation.ts"),
    import("../integration/distillationRuntime.ts"),
  ]);
  const [executor, selector] = await Promise.all([
    runtime.createDefaultProductionExecutorDeps(),
    runtime.createDefaultProductionSelectorDeps(),
  ]);
  return {
    store: repo.createDistillationStore(),
    executor,
    selector,
    handlers: {},
    enqueueTask: repo.enqueueDistillationTask,
    planL1Task: (await import("../integration/l1Scheduling.ts")).planPendingL1Task,
    expediteQueuedTasks: repo.expediteDistillationTasks,
    listTasks: repo.listDistillationTasks,
    listDlqEntries: repo.listDistillationDlqEntries,
    buildL3Task: (await import("./apply.ts")).buildL3PersonaTask,
    env: process.env,
  };
}

// ────────────────────────────── Registry reads ──────────────────────────────

export function getDistillationRun(runId: string): DistillationRunRecord | null {
  return registry().get(runId)?.record ?? null;
}

/** Resolves when the run reaches a terminal state; null when unknown. */
export function whenDistillationRunSettles(runId: string): Promise<void> | null {
  return registry().get(runId)?.done ?? null;
}

/** Test-only — wipe the in-process run registry without waiting. */
export function __resetDistillationRunsForTests(): void {
  globalThis.__omnirouteDistillationRuns = new Map();
}

// ────────────────────────────── Run lifecycle ──────────────────────────────

function normalizeLayers(layers: readonly DistillationRunLayer[]): DistillationRunLayer[] {
  const selected = new Set(layers);
  return CANONICAL_LAYER_ORDER.filter((layer) => selected.has(layer));
}

/**
 * Start an explicit run. Returns the accepted record immediately; execution
 * continues in the background and the record in the registry is updated as
 * layers progress.
 */
export async function startDistillationRun(
  input: StartDistillationRunInput,
  deps?: DistillationRunDeps
): Promise<DistillationRunRecord> {
  const layers = normalizeLayers(input.layers);
  const now = Date.now();
  const record: DistillationRunRecord = {
    runId: randomUUID(),
    ownerApiKeyId: input.ownerApiKeyId,
    session: input.session,
    layers,
    layerTimeoutMs: input.layerTimeoutMs,
    status: "running",
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    layerStates: layers.map((layer) => ({
      layer,
      status: "pending" as const,
      taskIds: [],
      error: null,
      startedAt: null,
      finishedAt: null,
    })),
    evidence: null,
  };

  const resolvedDeps = deps ?? (await resolveRunDeps());
  const done = executeRun(record, resolvedDeps).catch(() => undefined);
  const map = registry();
  map.set(record.runId, { record, done });
  pruneRegistry(map);
  return { ...record };
}

interface LayerFailure {
  kind: string;
  message: string;
}

async function executeRun(record: DistillationRunRecord, deps: DistillationRunDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const config = resolveDistillationConfig(deps.env ?? process.env);
  let catalog: CatalogSnapshot | null = null;
  let failed = false;

  for (const state of record.layerStates) {
    if (failed) {
      state.status = "skipped";
      state.finishedAt = now();
      continue;
    }
    state.status = "running";
    state.startedAt = now();
    record.updatedAt = now();
    try {
      const loadCatalog = async (): Promise<CatalogSnapshot> => {
        catalog ??= await deps.selector.loadCatalogSnapshot();
        return catalog;
      };
      const outcome = await executeLayer(state, record, deps, config, loadCatalog, now);
      state.status = outcome.ok ? "succeeded" : "failed";
      if (!outcome.ok) {
        state.error = outcome.error;
        failed = true;
      }
    } catch (error: unknown) {
      state.status = "failed";
      state.error = {
        kind: "orchestration_error",
        message: sanitizeMessage(
          error instanceof Error ? error.message : "Distillation run crashed"
        ),
      };
      failed = true;
    }
    state.finishedAt = now();
    record.updatedAt = now();
  }

  record.status = failed ? "failed" : "succeeded";
  record.finishedAt = now();
  record.updatedAt = now();
  record.evidence = buildEvidence(deps, record.ownerApiKeyId);
}

async function executeLayer(
  state: DistillationRunLayerState,
  record: DistillationRunRecord,
  deps: DistillationRunDeps,
  config: ReturnType<typeof resolveDistillationConfig>,
  loadCatalog: () => Promise<CatalogSnapshot>,
  now: () => number
): Promise<{ ok: true } | { ok: false; error: LayerFailure }> {
  const scope = record.ownerApiKeyId;
  const kinds = LAYER_KINDS[state.layer];
  const deadline = now() + record.layerTimeoutMs;

  if (state.layer === "l1") {
    const planned = deps.planL1Task({
      scope,
      sessionId: record.session,
      correlationId: null,
      capturedAt: new Date(now()).toISOString(),
      now: now(),
    });
    if (planned) {
      // Explicit run = no L1 debounce; the batch is due immediately.
      deps.enqueueTask({ ...planned, notBefore: now(), coalesceNotBefore: "replace" });
    }
  }

  if (state.layer === "l3") {
    const built = deps.buildL3Task(scope);
    if (!built) {
      return {
        ok: false,
        error: {
          kind: "no_input",
          message: "L3 requires at least one L2 scene; nothing was produced",
        },
      };
    }
    // Forced L3 — never suppressible by the background gating.
    deps.enqueueTask({ ...built, notBefore: now(), coalesceNotBefore: "replace" });
  }

  for (let executed = 0; executed < MAX_TASKS_PER_LAYER; executed++) {
    if (now() >= deadline) {
      return {
        ok: false,
        error: {
          kind: "layer_timeout",
          message: `Layer ${state.layer} exceeded its ${record.layerTimeoutMs}ms budget`,
        },
      };
    }
    // Pull this layer's queued work forward to "due now" — background
    // debounce cadences must not stall an explicit run.
    deps.expediteQueuedTasks(scope, kinds, now());
    const claim = await deps.store.claimNextTask(now(), scope, kinds);
    if (!claim.task) break;

    const outcome = await executeRunTask(
      claim.task,
      claim.leaseMs,
      deps,
      config,
      loadCatalog,
      deadline
    );
    state.taskIds.push(claim.task.id);
    record.updatedAt = now();
    if (!("ok" in outcome) || !outcome.ok) {
      return { ok: false, error: outcome.error };
    }
  }
  return { ok: true };
}

interface TaskOutcome {
  ok: boolean;
  error?: LayerFailure;
}

async function executeRunTask(
  task: DistillationTask,
  leaseMs: number,
  deps: DistillationRunDeps,
  config: ReturnType<typeof resolveDistillationConfig>,
  loadCatalog: () => Promise<CatalogSnapshot>,
  deadline: number
): Promise<TaskOutcome> {
  const ownerId = `run:${randomUUID()}`;
  const claimed = await deps.store.markClaimed(task.id, task.version, ownerId, leaseMs);
  if (!claimed) {
    // Another worker won the optimistic claim — nothing for this run to do.
    return { ok: true };
  }

  const lock = await deps.store.acquireLock(task.scope, ownerId, RUN_LOCK_TTL_MS);
  if (!lock) {
    await deps.store.markSkippedBreaker(
      task.id,
      ownerId,
      Date.now() + 15_000,
      "scope locked by another distillation worker"
    );
    return {
      ok: false,
      error: {
        kind: "scope_locked",
        message: "Owner scope is locked by another distillation worker",
      },
    };
  }

  try {
    const fail = async (failure: LayerFailure, dlqKind: string): Promise<TaskOutcome> => {
      await terminateTask(deps, task, ownerId, failure, dlqKind);
      return { ok: false, error: failure };
    };

    const selection = await resolveDistillationSelection(task, deps.selector);
    if (!selection) {
      return fail({ kind: "model_unset", message: "No provider/model available" }, "model_unset");
    }
    const catalog = await loadCatalog();
    const validation = validateModelStillUsable(selection, catalog);
    if (!validation.ok) {
      return fail(
        {
          kind: validation.reason,
          message: `Selected model unusable: ${validation.reason}`,
        },
        validation.reason
      );
    }

    const handler = deps.handlers[task.kind] ?? DEFAULT_HANDLERS[task.kind];
    if (!handler) {
      return fail(
        { kind: "model_unset", message: `No handler for kind=${task.kind}` },
        "model_unset"
      );
    }

    await deps.store.markRunning(task.id, ownerId);

    let costPerKTokenIn: number | undefined;
    let costPerKTokenOut: number | undefined;
    let outcome: HandlerOutcome;
    try {
      outcome = await withDeadline(
        handler({
          task,
          selection,
          budget: {
            maxTokens: config.maxTokens,
            maxSteps: config.maxSteps,
            maxCalls: config.maxCalls,
            maxDepth: config.maxDepth,
          },
          callModel: async ({ messages, maxTokens }) => {
            const marker = signInternalMarker(config.secret, {
              depth: 0,
              callsRemaining: config.maxCalls,
            });
            const execution = await executeDistillationTask({
              task,
              provider: selection.provider,
              model: selection.model,
              messages,
              maxTokens,
              internalHeaders: marker.headers,
              deps: deps.executor,
            });
            if (execution.status === "breaker_open") {
              throw makeRunError("BREAKER_OPEN", "Provider breaker is OPEN");
            }
            if (execution.status !== "ok" || !execution.result) {
              throw makeRunError(
                "EXECUTOR_FAILURE",
                execution.failure?.message ?? "Distillation executor failed"
              );
            }
            costPerKTokenIn = execution.result.costPerKTokenIn;
            costPerKTokenOut = execution.result.costPerKTokenOut;
            return {
              text: execution.result.text,
              promptTokens: execution.result.promptTokens,
              completionTokens: execution.result.completionTokens,
            };
          },
        }),
        deadline,
        "layer_timeout"
      );
    } catch (error: unknown) {
      const failure = classifyFailure(error);
      return fail(
        { kind: failure.kind, message: failure.message },
        failure.kind === "breaker_open" ? "no_retry" : dlqKindFor(failure.kind)
      );
    }

    if (!outcome.ok) {
      return fail(
        { kind: outcome.error.kind, message: outcome.error.message },
        dlqKindFor(outcome.error.kind)
      );
    }

    const usage = buildUsageRecord({
      taskId: task.id,
      scope: task.scope,
      kind: task.kind,
      provider: selection.provider,
      model: selection.model,
      promptTokens: outcome.result.promptTokens,
      completionTokens: outcome.result.completionTokens,
      costPerKTokenIn,
      costPerKTokenOut,
    });
    try {
      await deps.store.completeTask(
        task,
        ownerId,
        {
          payload: outcome.result.payload,
          fallbackEvidence: outcome.result.fallbackEvidence,
        },
        usage
      );
    } catch (error: unknown) {
      const message = sanitizeMessage(
        error instanceof Error ? error.message : "Canonical memory apply failed"
      );
      const semantic =
        error instanceof Error &&
        (error as { code?: unknown }).code === "DISTILLATION_APPLY_INVALID";
      return fail(
        {
          kind: semantic ? "semantic_invalid" : "retry_storage",
          message,
        },
        semantic ? "semantic_invalid" : "no_retry"
      );
    }
    return { ok: true };
  } finally {
    await deps.store.releaseLock(task.scope, ownerId).catch(() => undefined);
  }
}

interface RunError extends Error {
  code: string;
}

function makeRunError(code: string, message: string): RunError {
  const error = new Error(message) as RunError;
  error.code = code;
  return error;
}

function dlqKindFor(kind: string): string {
  const known = new Set([
    "retry_exhausted",
    "no_retry",
    "model_lockout",
    "parse_failed",
    "semantic_invalid",
    "budget_exceeded",
    "model_unset",
    "model_deleted",
    "credentials_invalid",
  ]);
  return known.has(kind) ? kind : "no_retry";
}

/** Failure is terminal in an explicit run — DLQ with evidence, never retry. */
async function terminateTask(
  deps: DistillationRunDeps,
  task: DistillationTask,
  ownerId: string,
  failure: LayerFailure,
  dlqKind: string
): Promise<void> {
  await deps.store.moveToDLQ(task.id, ownerId, {
    taskId: task.id,
    reason: failure.kind,
    failureKind: dlqKind as never,
    attempts: task.attempt,
    error: sanitizeMessage(failure.message),
    recordedAt: Date.now(),
  });
}

function withDeadline<T>(promise: Promise<T>, deadline: number, kind: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      promise.catch(() => undefined);
      reject(makeRunError(kind, "Layer timeout budget exhausted"));
      return;
    }
    const timer = setTimeout(() => {
      promise.catch(() => undefined);
      reject(makeRunError(kind, "Layer timeout budget exhausted"));
    }, remaining);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function buildEvidence(deps: DistillationRunDeps, scope: string): DistillationRunEvidence {
  const tasks = deps.listTasks({ scope, kinds: ["L1_extract", "L2_scene", "L3_persona"] });
  const dlq = deps.listDlqEntries({ scope });
  return {
    tasks: tasks.map((task) => ({
      id: task.id,
      kind: task.kind,
      status: task.status,
      lastError: task.lastError,
    })),
    dlq: dlq.map((entry) => ({
      taskId: entry.taskId,
      reason: entry.reason,
      failureKind: entry.failureKind,
      error: entry.error,
      recordedAt: entry.recordedAt,
    })),
  };
}
