import { isAutomatedTestProcess, isBuildProcess } from "@/shared/utils/testProcess";

import { runRetentionCleanup } from "../db/repositories/retention.ts";

const DEFAULT_INITIAL_DELAY_MS = 60_000;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_RETENTION_DAYS = 365_000;

type TimerHandle = ReturnType<typeof setTimeout>;

interface TimerScheduler {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  setInterval(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  clearInterval(handle: TimerHandle): void;
}

export interface MemoryRetentionCleanupResult {
  deletedL0Messages: number;
  deletedL1Memories: number;
  deletedL1Versions: number;
}

export interface RunMemoryRetentionCleanupOptions {
  env?: NodeJS.ProcessEnv;
  now?: number;
}

export interface StartMemoryRetentionCleanerOptions {
  env?: NodeJS.ProcessEnv;
  runtime?: {
    allowAutomatedTestProcess?: boolean;
    isBuildProcess?: boolean;
    isCloudRuntime?: boolean;
  };
  schedule?: TimerScheduler;
  cleanup?: () => Promise<MemoryRetentionCleanupResult> | MemoryRetentionCleanupResult;
  logger?: Pick<Console, "warn">;
}

interface MemoryRetentionCleanerState {
  timeout: TimerHandle | null;
  interval: TimerHandle | null;
  schedule: TimerScheduler;
  running: boolean;
  stopping: boolean;
  currentRun: Promise<void> | null;
  cleanup: () => Promise<MemoryRetentionCleanupResult> | MemoryRetentionCleanupResult;
  logger: Pick<Console, "warn">;
}

declare global {
  var __omnirouteMemoryRetentionCleaner: MemoryRetentionCleanerState | undefined;
}

const DEFAULT_SCHEDULER: TimerScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
  clearInterval: (handle) => clearInterval(handle),
};

function isCloudRuntime(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof globalThis.caches === "object" &&
    globalThis.caches !== null
  );
}

function backgroundServicesDisabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES?.trim().toLowerCase();
  return raw !== undefined && new Set(["1", "true", "yes", "on"]).has(raw);
}

function emptyCleanupResult(): MemoryRetentionCleanupResult {
  return {
    deletedL0Messages: 0,
    deletedL1Memories: 0,
    deletedL1Versions: 0,
  };
}

export function parseMemoryRetentionDays(raw: string | undefined): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_RETENTION_DAYS) return null;
  return parsed;
}

export function runMemoryRetentionCleanup(
  options: RunMemoryRetentionCleanupOptions = {}
): MemoryRetentionCleanupResult {
  const env = options.env ?? process.env;
  const l0Days = parseMemoryRetentionDays(env.MEMORY_L0_RETENTION);
  const l1Days = parseMemoryRetentionDays(env.MEMORY_L1_RETENTION);
  if (l0Days === null && l1Days === null) return emptyCleanupResult();

  const now = options.now ?? Date.now();
  return runRetentionCleanup({ now, l0Days, l1Days });
}

async function runCleanerTick(state: MemoryRetentionCleanerState): Promise<void> {
  if (state.stopping || state.running) return;
  state.running = true;
  state.currentRun = (async () => {
    try {
      await state.cleanup();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      state.logger.warn("[memory.retention] Cleanup failed (non-fatal):", message);
    } finally {
      state.running = false;
      state.currentRun = null;
    }
  })();
  await state.currentRun;
}

export async function startMemoryRetentionCleaner(
  options: StartMemoryRetentionCleanerOptions = {}
): Promise<boolean> {
  const env = options.env ?? process.env;
  if (
    parseMemoryRetentionDays(env.MEMORY_L0_RETENTION) === null &&
    parseMemoryRetentionDays(env.MEMORY_L1_RETENTION) === null
  ) {
    return false;
  }
  if (backgroundServicesDisabled(env)) return false;
  if (options.runtime?.isBuildProcess ?? isBuildProcess(env)) return false;
  if (options.runtime?.isCloudRuntime ?? isCloudRuntime()) return false;
  if (!options.runtime?.allowAutomatedTestProcess && isAutomatedTestProcess(undefined, env)) {
    return false;
  }
  if (globalThis.__omnirouteMemoryRetentionCleaner) return false;

  const schedule = options.schedule ?? DEFAULT_SCHEDULER;
  const state: MemoryRetentionCleanerState = {
    timeout: null,
    interval: null,
    schedule,
    running: false,
    stopping: false,
    currentRun: null,
    cleanup: options.cleanup ?? (() => runMemoryRetentionCleanup({ env })),
    logger: options.logger ?? console,
  };
  globalThis.__omnirouteMemoryRetentionCleaner = state;

  state.timeout = schedule.setTimeout(() => {
    void runCleanerTick(state);
  }, DEFAULT_INITIAL_DELAY_MS);
  state.timeout.unref?.();
  state.interval = schedule.setInterval(() => {
    void runCleanerTick(state);
  }, DEFAULT_INTERVAL_MS);
  state.interval.unref?.();
  return true;
}

export async function stopMemoryRetentionCleaner(): Promise<void> {
  const state = globalThis.__omnirouteMemoryRetentionCleaner;
  if (!state) return;
  state.stopping = true;
  if (state.timeout) {
    state.schedule.clearTimeout(state.timeout);
    state.timeout = null;
  }
  if (state.interval) {
    state.schedule.clearInterval(state.interval);
    state.interval = null;
  }
  if (state.currentRun) await state.currentRun;
  if (globalThis.__omnirouteMemoryRetentionCleaner === state) {
    globalThis.__omnirouteMemoryRetentionCleaner = undefined;
  }
}
