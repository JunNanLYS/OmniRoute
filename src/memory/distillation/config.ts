/**
 * Distillation worker — configuration (opt-in, doubly-gated).
 *
 * Scope: pure resolution of every process-env knob the worker reads.
 * NO side effects; safe to call from tests and from the worker boot.
 *
 * Hard rule (TV4 / plan #10): the worker is doubly opt-in:
 *   - Master switch: `MEMORY_DISTILLATION_ENABLED === "true"`.
 *   - Cadence:       `MEMORY_DISTILLATION_INTERVAL` (seconds) MUST be > 0.
 * Either missing → worker stays cold (startDistillationWorker is a no-op).
 *
 * Hard rule: the worker MUST NOT start when:
 *   - isBuildPhase (Next.js production build phase)
 *   - isCloud       (Cloudflare Workers / cache API present)
 *   - isAutomatedTestProcess (test runner detected)
 *
 * Knobs:
 *   MEMORY_DISTILLATION_ENABLED         master switch
 *   MEMORY_DISTILLATION_INTERVAL        seconds between polls (default 60)
 *   MEMORY_DISTILLATION_CONCURRENCY     process permit pool size (default 3)
 *   MEMORY_DISTILLATION_MAX_DEPTH       depth header cap (default 6)
 *   MEMORY_DISTILLATION_MAX_CALLS       call budget for nested loops (default 12)
 *   MEMORY_DISTILLATION_MAX_STEPS       executor step cap (default 8)
 *   MEMORY_DISTILLATION_MAX_TOKENS      per-task token cap (default 8192)
 *   MEMORY_DISTILLATION_MODEL           provider/model override (`prov/model`)
 *   MEMORY_DISTILLATION_SECRET          process-local HMAC secret; auto-generated
 *                                        if absent. NOT a CLI override surface —
 *                                        kept secret from clients.
 */

export interface DistillationEnvConfig {
  enabled: boolean;
  intervalMs: number;
  concurrency: number;
  maxDepth: number;
  maxCalls: number;
  maxSteps: number;
  maxTokens: number;
  modelOverride: { provider: string; model: string } | null;
  /** Internal HMAC secret. Persisted on globalThis for the lifetime of the process. */
  secret: Uint8Array;
}

export const DEFAULT_DISTILLATION_INTERVAL_SECONDS = 60;
export const DEFAULT_DISTILLATION_CONCURRENCY = 3;
export const DEFAULT_DISTILLATION_MAX_DEPTH = 6;
export const DEFAULT_DISTILLATION_MAX_CALLS = 12;
export const DEFAULT_DISTILLATION_MAX_STEPS = 8;
export const DEFAULT_DISTILLATION_MAX_TOKENS = 8192;
export const DEFAULT_DISTILLATION_SECRET_BYTES = 32;

declare global {
  var __omnirouteDistillationSecret: Uint8Array | undefined;
}

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  // `0` is not a positive integer — treat it as unset so the caller falls
  // back to the default (e.g. a concurrency of `0` must not silently become 1).
  if (!Number.isFinite(n) || n < 1) return fallback;
  const clamped = Math.min(Math.floor(n), max);
  return clamped;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(Math.max(Math.floor(n), 0), max);
  return clamped;
}

/**
 * Parse `MEMORY_DISTILLATION_MODEL` in the canonical "provider/model" shape.
 * Accepts `"prov/model"` (most common) and `"prov:model"` (legacy).
 * Whitespace tolerated; empty string returns null. Anything that does not
 * split into exactly two non-empty parts returns null — caller falls back
 * to global/per-key selection.
 */
export function parseDistillationModelOverride(
  raw: string | undefined
): { provider: string; model: string } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const separator = trimmed.includes("/") ? "/" : trimmed.includes(":") ? ":" : null;
  if (separator === null) return null;
  const [rawProvider, rawModel] = trimmed.split(separator);
  const provider = (rawProvider ?? "").trim();
  const model = (rawModel ?? "").trim();
  if (!provider || !model) return null;
  return { provider, model };
}

function resolveSecret(env: NodeJS.ProcessEnv): Uint8Array {
  const explicit = env.MEMORY_DISTILLATION_SECRET;
  if (typeof explicit === "string" && explicit.length >= 16) {
    // Deterministic encoding of the explicit string — operators can pin it
    // for cross-process verification, but it is NEVER sent to clients.
    const out = new Uint8Array(DEFAULT_DISTILLATION_SECRET_BYTES);
    let acc = 2166136261 >>> 0;
    for (let i = 0; i < explicit.length; i++) {
      acc ^= explicit.charCodeAt(i);
      acc = Math.imul(acc, 16777619) >>> 0;
    }
    for (let i = 0; i < out.length; i++) {
      acc = Math.imul(acc ^ i, 16777619) >>> 0;
      out[i] = acc & 0xff;
    }
    return out;
  }
  if (
    typeof globalThis !== "undefined" &&
    globalThis.__omnirouteDistillationSecret instanceof Uint8Array &&
    globalThis.__omnirouteDistillationSecret.length >= 16
  ) {
    return globalThis.__omnirouteDistillationSecret;
  }
  const generated = new Uint8Array(DEFAULT_DISTILLATION_SECRET_BYTES);
  if (typeof globalThis !== "undefined" && globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(generated);
  } else {
    // Last-resort: time-based seed. The HMAC is for internal loopback
    // authentication only; clients never see it.
    let s = Date.now() ^ ((globalThis as { process?: { pid?: number } }).process?.pid ?? 0);
    for (let i = 0; i < generated.length; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      generated[i] = s & 0xff;
    }
  }
  if (typeof globalThis !== "undefined") {
    globalThis.__omnirouteDistillationSecret = generated;
  }
  return generated;
}

/**
 * Resolve the full worker config from env. Pure — no I/O, no globals
 * beyond the secret cache (which is itself idempotent).
 */
export function resolveDistillationConfig(
  env: NodeJS.ProcessEnv = process.env
): DistillationEnvConfig {
  const intervalSeconds = parsePositiveInt(
    env.MEMORY_DISTILLATION_INTERVAL,
    DEFAULT_DISTILLATION_INTERVAL_SECONDS,
    24 * 60 * 60
  );
  return {
    enabled: env.MEMORY_DISTILLATION_ENABLED === "true",
    intervalMs: intervalSeconds * 1000,
    concurrency: parsePositiveInt(
      env.MEMORY_DISTILLATION_CONCURRENCY,
      DEFAULT_DISTILLATION_CONCURRENCY,
      32
    ),
    maxDepth: parsePositiveInt(
      env.MEMORY_DISTILLATION_MAX_DEPTH,
      DEFAULT_DISTILLATION_MAX_DEPTH,
      64
    ),
    maxCalls: parsePositiveInt(
      env.MEMORY_DISTILLATION_MAX_CALLS,
      DEFAULT_DISTILLATION_MAX_CALLS,
      256
    ),
    maxSteps: parsePositiveInt(
      env.MEMORY_DISTILLATION_MAX_STEPS,
      DEFAULT_DISTILLATION_MAX_STEPS,
      64
    ),
    maxTokens: parseNonNegativeInt(
      env.MEMORY_DISTILLATION_MAX_TOKENS,
      DEFAULT_DISTILLATION_MAX_TOKENS,
      131072
    ),
    modelOverride: parseDistillationModelOverride(env.MEMORY_DISTILLATION_MODEL),
    secret: resolveSecret(env),
  };
}

/**
 * Whether the worker is allowed to start under the current environment.
 * Hard-coded set: build phase, cloud runtime, automated test process.
 * Combines with the doubly opt-in check at startDistillationWorker.
 */
export function isWorkerStartAllowed(
  env: NodeJS.ProcessEnv = process.env,
  isBuildPhaseFlag: boolean,
  isCloudFlag: boolean,
  isAutomatedTestFlag: boolean
): boolean {
  if (isBuildPhaseFlag) return false;
  if (isCloudFlag) return false;
  if (isAutomatedTestFlag) return false;
  const disabled = env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES?.trim().toLowerCase();
  if (disabled && new Set(["1", "true", "yes", "on"]).has(disabled)) return false;
  return true;
}
