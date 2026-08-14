/**
 * Global distillation-worker runtime settings.
 *
 * Unlike memory capture/injection, these values are process-global: they
 * control one background worker, not an individual API-key owner. A persisted
 * row overrides the environment fallback; with no row the worker remains
 * doubly opt-in exactly as before.
 */

import { deleteSetting, getSetting, upsertSetting } from "../operations.ts";
import {
  DEFAULT_DISTILLATION_CONCURRENCY,
  DEFAULT_DISTILLATION_INTERVAL_SECONDS,
} from "../distillation/config.ts";

export interface DistillationWorkerRuntimeConfig {
  enabled: boolean;
  intervalSeconds: number;
  concurrency: number;
  sourceLayer: "stored" | "env" | "default";
}

export interface DistillationWorkerRuntimeConfigPut {
  enabled: boolean;
  intervalSeconds: number;
  concurrency: number;
}

const WORKER_SETTINGS_KEY = "distillation.worker.global";
const MAX_INTERVAL_SECONDS = 24 * 60 * 60;
const MAX_CONCURRENCY = 32;

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function parseEnvBoolean(raw: string | undefined): boolean {
  return raw === "true";
}

function parseStoredConfig(raw: string | null): DistillationWorkerRuntimeConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DistillationWorkerRuntimeConfigPut>;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return {
      enabled: parsed.enabled === true,
      intervalSeconds: clampInteger(
        parsed.intervalSeconds,
        DEFAULT_DISTILLATION_INTERVAL_SECONDS,
        1,
        MAX_INTERVAL_SECONDS
      ),
      concurrency: clampInteger(
        parsed.concurrency,
        DEFAULT_DISTILLATION_CONCURRENCY,
        1,
        MAX_CONCURRENCY
      ),
      sourceLayer: "stored",
    };
  } catch {
    return null;
  }
}

function resolveEnvironmentConfig(
  env: NodeJS.ProcessEnv = process.env
): DistillationWorkerRuntimeConfig {
  const intervalRaw = env.MEMORY_DISTILLATION_INTERVAL;
  const concurrencyRaw = env.MEMORY_DISTILLATION_CONCURRENCY;
  const interval =
    typeof intervalRaw === "string" && Number(intervalRaw) > 0
      ? clampInteger(intervalRaw, DEFAULT_DISTILLATION_INTERVAL_SECONDS, 1, MAX_INTERVAL_SECONDS)
      : DEFAULT_DISTILLATION_INTERVAL_SECONDS;
  const concurrency =
    typeof concurrencyRaw === "string" && Number(concurrencyRaw) > 0
      ? clampInteger(concurrencyRaw, DEFAULT_DISTILLATION_CONCURRENCY, 1, MAX_CONCURRENCY)
      : DEFAULT_DISTILLATION_CONCURRENCY;
  const enabled = parseEnvBoolean(env.MEMORY_DISTILLATION_ENABLED) && interval > 0;
  const sourceLayer =
    intervalRaw !== undefined ||
    concurrencyRaw !== undefined ||
    env.MEMORY_DISTILLATION_ENABLED !== undefined
      ? "env"
      : "default";
  return { enabled, intervalSeconds: interval, concurrency, sourceLayer };
}

/**
 * Resolution order: stored global runtime row → environment → disabled default.
 * The secret is deliberately not part of this API or persisted config.
 */
export function resolveDistillationWorkerRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): DistillationWorkerRuntimeConfig {
  const stored = parseStoredConfig(getSetting(WORKER_SETTINGS_KEY)?.value ?? null);
  if (stored) return stored;
  return resolveEnvironmentConfig(env);
}

export function saveDistillationWorkerRuntimeConfig(
  input: DistillationWorkerRuntimeConfigPut
): DistillationWorkerRuntimeConfig {
  const normalized: DistillationWorkerRuntimeConfig = {
    enabled: input.enabled === true,
    intervalSeconds: clampInteger(
      input.intervalSeconds,
      DEFAULT_DISTILLATION_INTERVAL_SECONDS,
      1,
      MAX_INTERVAL_SECONDS
    ),
    concurrency: clampInteger(
      input.concurrency,
      DEFAULT_DISTILLATION_CONCURRENCY,
      1,
      MAX_CONCURRENCY
    ),
    sourceLayer: "stored",
  };
  upsertSetting(WORKER_SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

export function deleteDistillationWorkerRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): DistillationWorkerRuntimeConfig {
  deleteSetting(WORKER_SETTINGS_KEY);
  return resolveDistillationWorkerRuntimeConfig(env);
}
