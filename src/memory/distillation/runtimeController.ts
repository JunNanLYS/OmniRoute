/**
 * Runtime controller for the in-process distillation worker.
 *
 * The route owns persisted configuration; this module owns the worker global
 * and start/stop behavior. It never reads or exposes the HMAC secret.
 */

import { stopDistillationWorker } from "./worker.ts";

export interface RuntimeWorkerConfig {
  enabled: boolean;
  intervalSeconds: number;
  concurrency: number;
}

export interface DistillationWorkerStatus {
  state: "stopped" | "starting" | "running" | "stopping";
  activeTasks: number;
  configuredIntervalSeconds: number | null;
  configuredConcurrency: number | null;
}

function activeWorker() {
  return globalThis.__omnirouteDistillationWorker ?? null;
}

/**
 * Read-only status. `starting` and `stopping` are represented by their worker
 * globals; a worker is `running` only after its timer handle is installed.
 */
export function getDistillationWorkerStatus(): DistillationWorkerStatus {
  if (globalThis.__omnirouteDistillationWorkerStartup) {
    return {
      state: "starting",
      activeTasks: 0,
      configuredIntervalSeconds: null,
      configuredConcurrency: null,
    };
  }
  if (globalThis.__omnirouteDistillationWorkerStop) {
    const worker = activeWorker();
    return {
      state: "stopping",
      activeTasks: worker?.activeTasks.size ?? 0,
      configuredIntervalSeconds: worker ? Math.round(worker.config.intervalMs / 1000) : null,
      configuredConcurrency: worker?.permitPool.size ?? null,
    };
  }
  const worker = activeWorker();
  if (!worker) {
    return {
      state: "stopped",
      activeTasks: 0,
      configuredIntervalSeconds: null,
      configuredConcurrency: null,
    };
  }
  return {
    state: "running",
    activeTasks: worker.activeTasks.size,
    configuredIntervalSeconds: Math.round(worker.config.intervalMs / 1000),
    configuredConcurrency: worker.permitPool.size,
  };
}

function runtimeEnv(config: RuntimeWorkerConfig, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    MEMORY_DISTILLATION_ENABLED: config.enabled ? "true" : "false",
    MEMORY_DISTILLATION_INTERVAL: String(config.intervalSeconds),
    MEMORY_DISTILLATION_CONCURRENCY: String(config.concurrency),
  };
}

/**
 * Bring the worker to the requested state. Enabling starts a worker with the
 * persisted interval/concurrency; disabling drains it (up to 5 seconds).
 * Reconfiguration stops first so the permit pool and interval are recreated.
 */
export async function reconcileDistillationWorker(
  config: RuntimeWorkerConfig,
  options: { startWorker?: typeof startProductionDistillationWorker } = {}
): Promise<DistillationWorkerStatus> {
  const start = options.startWorker ?? startProductionDistillationWorker;
  const active = getDistillationWorkerStatus().state !== "stopped";
  if (active) await stopDistillationWorker();
  if (!config.enabled || config.intervalSeconds <= 0) return getDistillationWorkerStatus();

  await start({ env: runtimeEnv(config, process.env) });
  return getDistillationWorkerStatus();
}

async function startProductionDistillationWorker(options: {
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const { startProductionDistillationWorker: start } =
    await import("../integration/distillationRuntime.ts");
  return start(options);
}
