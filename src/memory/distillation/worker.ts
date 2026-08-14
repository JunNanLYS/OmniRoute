/**
 * Distillation worker — the lifecycle orchestrator.
 *
 * Public surface:
 *
 *   startDistillationWorker(deps?) → boolean
 *     Idempotent; returns true when the worker actually started.
 *
 *   stopDistillationWorker() → Promise<void>
 *     Waits for in-flight tasks to drain up to a small grace window.
 *
 * Boot:
 *   - Doubly opt-in via env (MEMORY_DISTILLATION_ENABLED=true AND
 *     MEMORY_DISTILLATION_INTERVAL>0). Both missing → no-op.
 *   - No start under isBuildPhase / isCloud / isAutomatedTestProcess.
 *
 * Loop:
 *   1. setTimeout(initialDelay, tick) — first poll is fast (200 ms), then
 *      `config.intervalMs` thereafter. Both timers are unref'd so the
 *      worker never blocks process exit.
 *   2. tick() acquires a permit; on miss, sleeps for `idleSleepMs()`.
 *   3. claims the next task from the store.
 *   4. resolves the selection; surfaces model_unset / model_deleted /
 *      credentials_invalid as DLQ entries (no silent fallback).
 *   5. runs the kind-specific handler; classifies failure; either retries
 *      (with backoff) or DLQs (with sanitized message).
 *   6. breaker-open is a NO-op for the attempt — task is left queued with
 *      `notBefore = now + breakerRetryAfterMs` so the next tick re-polls.
 *   7. usage is recorded via the batcher; flushes on every successful task
 *      and on shutdown.
 *
 * Cross-cutting concerns:
 *   - Synchronous reentry guard via a module-level `running` flag.
 *   - Owner-level lock per scope (default TTL 240 s, renew every 30 s).
 *   - Internal marker HMAC secret is minted at boot and threaded into the
 *     `internalMarker` module via `setInternalMarkerSecret`.
 */

import { randomUUID } from "node:crypto";

import { resolveDistillationConfig, isWorkerStartAllowed } from "./config.ts";
import {
  InMemoryDistillationStore,
  createDefaultDistillationStore,
  type DistillationStore,
  type DistillationTask,
  type DistillationTaskKind,
} from "./store.ts";
import { ProcessPermitPool, releasePermit, type AcquiredPermit } from "./permit.ts";
import { initialDelayForKind, nextWarmupDelayMs } from "./scheduler.ts";
import {
  resolveDistillationSelection,
  validateModelStillUsable,
  type SelectorDeps,
} from "./selector.ts";
import { classifyFailure, decideRetry, sanitizeMessage, type ClassifiedError } from "./failure.ts";
import { signInternalMarker } from "./internalMarker.ts";
import { withOwnerLock, type OwnerLockHandle } from "./lock.ts";
import { UsageBatcher, buildUsageRecord } from "./usage.ts";
import { DEFAULT_HANDLERS, type DistillationHandler, type HandlerError } from "./handlers.ts";
import type { ExecutorDeps } from "./executor.ts";
import { executeDistillationTask, makeCodedError } from "./executor.ts";
import { isAutomatedTestProcess, isBuildProcess } from "@/shared/utils/testProcess";

/**
 * Cloudflare Workers / Cloudflare Pages detection — mirrors `isCloud` in
 * `@/lib/db/core.ts` but reachable without importing the DB layer (which
 * would drag in better-sqlite3 etc. into the worker module). The runtime
 * detection is the same: presence of the `caches` global.
 */
function isCloudRuntime(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof globalThis.caches === "object" &&
    globalThis.caches !== null
  );
}

interface WorkerStartupReservation {
  cancelled: boolean;
  done: Promise<void>;
  resolveDone(): void;
}

declare global {
  var __omnirouteDistillationWorkerStartup: WorkerStartupReservation | undefined;
  var __omnirouteDistillationWorkerStop: Promise<void> | undefined;
  var __omnirouteDistillationWorker:
    | {
        timer: ReturnType<typeof setTimeout> | null;
        interval: ReturnType<typeof setInterval> | null;
        store: DistillationStore;
        permitPool: ProcessPermitPool;
        usage: UsageBatcher;
        running: boolean;
        stopping: boolean;
        config: ReturnType<typeof resolveDistillationConfig>;
        executorDeps: ExecutorDeps | null;
        handlers: Record<DistillationTaskKind, DistillationHandler>;
        selectorDeps: SelectorDeps | null;
        activeLocks: Map<string, OwnerLockHandle>;
        activeTasks: Set<string>;
        consecutiveSuccesses: number;
        taskLeaseRenewMs: number;
        taskLeaseMs: number;
        ownerId: string;
        catalog: {
          providers: Map<string, readonly string[]>;
          isModelUsable(p: string, m: string): boolean;
        } | null;
      }
    | undefined;
}

const INITIAL_DELAY_MS = 200;
const SHUTDOWN_GRACE_MS = 5_000;
const TASK_LEASE_MS = 60_000;
const TASK_LEASE_RENEW_MS = 30_000;
const MAX_INFLIGHT_PER_SCOPE = 1;

function generateOwnerId(): string {
  const pid = typeof process !== "undefined" ? process.pid : 0;
  return `pid:${pid}:${randomUUID()}`;
}

function getWorker(): NonNullable<typeof globalThis.__omnirouteDistillationWorker> | null {
  return globalThis.__omnirouteDistillationWorker ?? null;
}

export interface WorkerRuntimeOptions {
  /** Test-only: allow construction under node:test/Vitest. */
  allowAutomatedTestProcess?: boolean;
  /** Test-only: construct the worker without installing timers. */
  scheduleTimers?: boolean;
  /** Test-only override for task lease renewal cadence. */
  taskLeaseRenewMs?: number;
  /** Test-only override for task lease duration. */
  taskLeaseMs?: number;
}

export interface StartDeps {
  store?: DistillationStore;
  executor?: ExecutorDeps;
  selector?: SelectorDeps;
  createStore?: () => Promise<DistillationStore> | DistillationStore;
  createExecutorDeps?: () => Promise<ExecutorDeps> | ExecutorDeps;
  createSelectorDeps?: () => Promise<SelectorDeps> | SelectorDeps;
  handlers?: Partial<Record<DistillationTaskKind, DistillationHandler>>;
  /** Explicit config source; production defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  runtime?: WorkerRuntimeOptions;
}

export interface StopOptions {
  /** Bypass the env opt-in (used only by tests). */
  force?: boolean;
  /** Override the shutdown grace window (tests only). */
  graceMs?: number;
}

function createStartupReservation(): WorkerStartupReservation {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  return { cancelled: false, done, resolveDone };
}

async function resolveStartDependencies(deps: StartDeps): Promise<{
  store: DistillationStore;
  executor: ExecutorDeps | null;
  selector: SelectorDeps | null;
}> {
  const [store, executor, selector] = await Promise.all([
    deps.store ?? (deps.createStore ?? createDefaultDistillationStore)(),
    deps.executor ?? deps.createExecutorDeps?.() ?? null,
    deps.selector ?? deps.createSelectorDeps?.() ?? null,
  ]);
  return { store, executor, selector };
}

/**
 * Start the worker. Returns `true` when the loop is scheduled. The function
 * is idempotent — calling it twice returns `false` on the second call.
 */
export async function startDistillationWorker(deps: StartDeps = {}): Promise<boolean> {
  const env = deps.env ?? process.env;
  const config = resolveDistillationConfig(env);
  const intervalRaw = env.MEMORY_DISTILLATION_INTERVAL;
  const explicitInterval = typeof intervalRaw === "string" ? Number(intervalRaw) : NaN;
  const automatedTest = deps.runtime?.allowAutomatedTestProcess ? false : isAutomatedTestProcess();
  if (!isWorkerStartAllowed(env, isBuildProcess(), isCloudRuntime(), automatedTest)) {
    return false;
  }
  if (
    !config.enabled ||
    !Number.isFinite(explicitInterval) ||
    explicitInterval <= 0 ||
    config.intervalMs <= 0
  ) {
    return false;
  }
  if (
    typeof globalThis !== "undefined" &&
    (globalThis.__omnirouteDistillationWorker ||
      globalThis.__omnirouteDistillationWorkerStartup ||
      globalThis.__omnirouteDistillationWorkerStop)
  ) {
    return false;
  }

  const startup = createStartupReservation();
  globalThis.__omnirouteDistillationWorkerStartup = startup;
  try {
    const dependencies = await resolveStartDependencies(deps);
    if (startup.cancelled) return false;

    const permitPool = new ProcessPermitPool({ size: config.concurrency });
    const usageBatcher = new UsageBatcher(dependencies.store);
    const handlers: Record<DistillationTaskKind, DistillationHandler> = {
      ...DEFAULT_HANDLERS,
      ...(deps.handlers ?? {}),
    };
    const catalog = dependencies.selector
      ? await dependencies.selector.loadCatalogSnapshot()
      : null;
    if (startup.cancelled) return false;

    const worker = {
      timer: null as ReturnType<typeof setTimeout> | null,
      interval: null as ReturnType<typeof setInterval> | null,
      store: dependencies.store,
      permitPool,
      usage: usageBatcher,
      running: false,
      stopping: false,
      config,
      executorDeps: dependencies.executor,
      handlers,
      selectorDeps: dependencies.selector,
      activeLocks: new Map<string, OwnerLockHandle>(),
      activeTasks: new Set<string>(),
      consecutiveSuccesses: 0,
      taskLeaseRenewMs: Math.max(1, deps.runtime?.taskLeaseRenewMs ?? TASK_LEASE_RENEW_MS),
      taskLeaseMs: Math.max(1, deps.runtime?.taskLeaseMs ?? TASK_LEASE_MS),
      ownerId: generateOwnerId(),
      catalog,
    };
    globalThis.__omnirouteDistillationWorker = worker;
    if (deps.runtime?.scheduleTimers !== false) {
      usageBatcher.start();
      worker.timer = setTimeout(() => {
        void tickOnce().catch(() => undefined);
      }, INITIAL_DELAY_MS);
      worker.timer.unref?.();
      worker.interval = setInterval(() => {
        void tickOnce().catch(() => undefined);
      }, config.intervalMs);
      worker.interval.unref?.();
    }
    return true;
  } finally {
    if (globalThis.__omnirouteDistillationWorkerStartup === startup) {
      delete globalThis.__omnirouteDistillationWorkerStartup;
    }
    startup.resolveDone();
  }
}

/**
 * Stop the worker. Awaits the best shutdown grace for in-flight work
 * (default 5 s). Safe to call multiple times.
 */
async function waitForPromiseUntil(promise: Promise<void>, deadline: number): Promise<boolean> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), remaining);
    timer.unref?.();
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function performWorkerStop(options: StopOptions): Promise<void> {
  const grace = Math.max(0, options.graceMs ?? SHUTDOWN_GRACE_MS);
  const deadline = Date.now() + grace;
  const startup = globalThis.__omnirouteDistillationWorkerStartup;
  if (startup) {
    startup.cancelled = true;
    await waitForPromiseUntil(startup.done, deadline);
  }

  const worker = getWorker();
  if (!worker) return;
  worker.stopping = true;
  if (worker.timer) {
    clearTimeout(worker.timer);
    worker.timer = null;
  }
  if (worker.interval) {
    clearInterval(worker.interval);
    worker.interval = null;
  }
  while ((worker.running || worker.activeTasks.size > 0) && Date.now() < deadline) {
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  }
  for (const handle of worker.activeLocks.values()) {
    try {
      await handle.release();
    } catch {
      // The task lease remains the crash-recovery fallback.
    }
  }
  worker.activeLocks.clear();
  try {
    await worker.usage.stop();
  } catch {
    // Database cleanup must continue even if usage flushing fails.
  }
  worker.running = false;
  worker.stopping = false;
  if (globalThis.__omnirouteDistillationWorker === worker) {
    delete globalThis.__omnirouteDistillationWorker;
  }
}

export function stopDistillationWorker(options: StopOptions = {}): Promise<void> {
  const existing = globalThis.__omnirouteDistillationWorkerStop;
  if (existing) return existing;

  const stopping = performWorkerStop(options).finally(() => {
    if (globalThis.__omnirouteDistillationWorkerStop === stopping) {
      delete globalThis.__omnirouteDistillationWorkerStop;
    }
  });
  globalThis.__omnirouteDistillationWorkerStop = stopping;
  return stopping;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const id = setTimeout(resolve, ms);
    if (typeof id.unref === "function") id.unref();
  });
}

/** Test-only — wipe the global worker handle without draining. */
export function __resetDistillationWorkerForTests(): void {
  if (typeof globalThis !== "undefined") {
    delete globalThis.__omnirouteDistillationWorker;
    delete globalThis.__omnirouteDistillationWorkerStartup;
    delete globalThis.__omnirouteDistillationWorkerStop;
  }
}

/**
 * One tick of the polling loop. Called by setInterval + the initial
 * setTimeout. The synchronous reentry guard prevents two ticks from
 * running concurrently when a tick exceeds the configured interval.
 */
export async function tickOnce(): Promise<void> {
  const worker = getWorker();
  if (!worker || worker.stopping || worker.running) return;
  worker.running = true;
  const processing: Promise<void>[] = [];
  try {
    for (let slot = 0; slot < worker.permitPool.size; slot++) {
      const permit = worker.permitPool.tryAcquire();
      if (!permit) break;
      const claim = await worker.store.claimNextTask(Date.now(), null);
      if (!claim.task) {
        releasePermit(permit);
        break;
      }
      const task = claim.task;
      const claimed = await worker.store.markClaimed(
        task.id,
        task.version,
        worker.ownerId,
        claim.leaseMs
      );
      if (!claimed) {
        releasePermit(permit);
        continue;
      }
      worker.activeTasks.add(task.id);
      processing.push(
        processTask(task, permit)
          .catch(async (error: unknown) => {
            await transitionUnexpectedFailure(task, error);
          })
          .finally(() => {
            worker.activeTasks.delete(task.id);
            releasePermit(permit);
          })
      );
    }
    await Promise.all(processing);
    await worker.usage.flush();
  } finally {
    worker.running = false;
  }
}

interface WorkerExecutorError extends Error {
  code: "BREAKER_OPEN" | "EXECUTOR_FAILURE";
  failure?: ClassifiedError;
  retryAfterMs?: number;
}

async function processTask(task: DistillationTask, _permit: AcquiredPermit): Promise<void> {
  const worker = getWorker();
  if (!worker) return;
  const leaseTimer = setInterval(() => {
    void worker.store.renewTaskLease(task.id, worker.ownerId, worker.taskLeaseMs);
  }, worker.taskLeaseRenewMs);
  leaseTimer.unref?.();
  try {
    await processClaimedTask(task, worker);
  } finally {
    clearInterval(leaseTimer);
  }
}

async function processClaimedTask(
  task: DistillationTask,
  worker: NonNullable<typeof globalThis.__omnirouteDistillationWorker>
): Promise<void> {
  if (!worker.executorDeps || !worker.selectorDeps) {
    await transitionFailure(task, {
      kind: "model_unset",
      retryable: false,
      triggersModelLockout: false,
      message: "Distillation executor or selector not wired",
    });
    return;
  }

  const lockHandle = await withOwnerLock(worker.store, task.scope, worker.ownerId);
  if (!lockHandle) {
    await worker.store.markSkippedBreaker(
      task.id,
      worker.ownerId,
      Date.now() + 15_000,
      "scope locked"
    );
    return;
  }
  worker.activeLocks.set(task.scope, lockHandle);

  try {
    const selection = await resolveDistillationSelection(task, worker.selectorDeps);
    if (!selection) {
      await transitionFailure(task, {
        kind: "model_unset",
        retryable: false,
        triggersModelLockout: false,
        message: "No provider/model available",
      });
      return;
    }

    const validation = worker.catalog
      ? validateModelStillUsable(selection, worker.catalog)
      : { ok: true as const };
    if (!validation.ok) {
      await transitionFailure(task, {
        kind: validation.reason,
        retryable: false,
        triggersModelLockout: validation.reason === "model_deleted",
        message: `Selected model unusable: ${validation.reason}`,
      });
      return;
    }

    const handler = worker.handlers[task.kind];
    if (!handler) {
      await transitionFailure(task, {
        kind: "model_unset",
        retryable: false,
        triggersModelLockout: false,
        message: `No handler for kind=${task.kind}`,
      });
      return;
    }

    await worker.store.markRunning(task.id, worker.ownerId);
    let costPerKTokenIn: number | undefined;
    let costPerKTokenOut: number | undefined;
    let outcome: Awaited<ReturnType<DistillationHandler>>;
    try {
      outcome = await handler({
        task,
        selection,
        budget: {
          maxTokens: worker.config.maxTokens,
          maxSteps: worker.config.maxSteps,
          maxCalls: worker.config.maxCalls,
          maxDepth: worker.config.maxDepth,
        },
        callModel: async ({ messages, maxTokens }) => {
          const marker = signInternalMarker(worker.config.secret, {
            depth: 0,
            callsRemaining: worker.config.maxCalls,
          });
          const execution = await executeDistillationTask({
            task,
            provider: selection.provider,
            model: selection.model,
            messages,
            maxTokens,
            internalHeaders: marker.headers,
            deps: worker.executorDeps!,
          });
          if (execution.status === "breaker_open") {
            const error = makeCodedError(
              "BREAKER_OPEN",
              "Provider breaker is OPEN"
            ) as WorkerExecutorError;
            error.retryAfterMs = execution.breakerRetryAfterMs;
            throw error;
          }
          if (execution.status !== "ok" || !execution.result) {
            const error = makeCodedError(
              "EXECUTOR_FAILURE",
              execution.failure?.message ?? "Distillation executor failed"
            ) as WorkerExecutorError;
            error.failure = execution.failure;
            throw error;
          }
          costPerKTokenIn = execution.result.costPerKTokenIn;
          costPerKTokenOut = execution.result.costPerKTokenOut;
          return {
            text: execution.result.text,
            promptTokens: execution.result.promptTokens,
            completionTokens: execution.result.completionTokens,
          };
        },
      });
    } catch (error: unknown) {
      const workerError = error as Partial<WorkerExecutorError>;
      if (workerError.code === "BREAKER_OPEN") {
        await worker.store.markSkippedBreaker(
          task.id,
          worker.ownerId,
          Date.now() + Math.max(workerError.retryAfterMs ?? 0, 5_000),
          "breaker open"
        );
        return;
      }
      await transitionFailure(task, workerError.failure ?? classifyFailure(error));
      return;
    }

    if (!outcome.ok) {
      await transitionFailure(task, classifyHandlerError(outcome.error));
      return;
    }

    const usageRecord = buildUsageRecord({
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
      await worker.store.completeTask(
        task,
        worker.ownerId,
        {
          payload: outcome.result.payload,
          fallbackEvidence: outcome.result.fallbackEvidence,
        },
        usageRecord
      );
    } catch (error: unknown) {
      await transitionFailure(task, classifyStorageFailure(error));
      return;
    }
    worker.consecutiveSuccesses++;
    void nextWarmupDelayMs(worker.consecutiveSuccesses);
  } finally {
    worker.activeLocks.delete(task.scope);
    await lockHandle.release().catch(() => undefined);
  }
}

function classifyStorageFailure(error: unknown): ClassifiedError {
  if (
    error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "DISTILLATION_APPLY_INVALID"
  ) {
    return {
      kind: "semantic_invalid",
      retryable: false,
      triggersModelLockout: false,
      message: sanitizeMessage(
        error instanceof Error ? error.message : "Canonical memory result is invalid"
      ),
    };
  }
  return {
    kind: "retry_storage",
    retryable: true,
    triggersModelLockout: false,
    message: sanitizeMessage(
      error instanceof Error ? error.message : "Canonical memory apply failed"
    ),
  };
}

function classifyHandlerError(error: HandlerError): ClassifiedError {
  return {
    kind: error.kind,
    retryable: false,
    triggersModelLockout: false,
    message: sanitizeMessage(error.message),
  };
}

async function transitionUnexpectedFailure(task: DistillationTask, error: unknown): Promise<void> {
  await transitionFailure(task, classifyFailure(error));
}

async function transitionFailure(task: DistillationTask, failure: ClassifiedError): Promise<void> {
  const worker = getWorker();
  if (!worker) return;
  const decision = decideRetry(failure, task.attempt);
  if (decision.retry) {
    await worker.store.markRetry(
      task.id,
      worker.ownerId,
      decision.nextAttempt,
      Date.now() + decision.backoffMs,
      failure.message
    );
    return;
  }
  await worker.store.moveToDLQ(task.id, worker.ownerId, {
    taskId: task.id,
    reason: failure.kind,
    failureKind: decision.dlqKind,
    attempts: task.attempt,
    error: failure.message,
    recordedAt: Date.now(),
  });
}

/** Public façade used by tests / API to enqueue work without the store. */
export function buildInitialDelayForKind(kind: DistillationTaskKind, now: number): number {
  return initialDelayForKind(kind, now);
}

/** Re-export the in-memory store for integration owners / tests. */
export { InMemoryDistillationStore } from "./store.ts";

// Cap import-only reference to avoid unused-var lint on the constant.
void MAX_INFLIGHT_PER_SCOPE;
