/**
 * Distillation executor — the runner that turns a task into a single LLM
 * call. Plain nonstream messages only; NEVER touches chatCore, combo,
 * aliases, or the AI SDK. This is by design: the worker must remain
 * observable and trivially circuit-breaker-friendly.
 *
 * Strict no-fallback rule: if the executor fails, the worker classifies
 * the failure and surfaces it. We do NOT retry under a different
 * provider/model — recall the spec: "No silent switch after selection".
 *
 * Breaker seam: the worker provides a `breakerCheck(provider)` hook. The
 * default hook queries the production circuit breaker by name. When the
 * breaker is OPEN we return `breaker_open` and the worker re-queues the
 * task WITHOUT counting it as an attempt.
 *
 * Internal marker: even when the worker calls the executor directly
 * (today, before the future tool loop is wired), it carries the
 * `is_internal=true` metadata so downstream code can defensively reject
 * the call if it ever reaches the public API surface.
 */

import type { ProviderCredentials } from "@omniroute/open-sse/executors/base.ts";
import type { DistillationTask } from "./store.ts";
import { classifyFailure } from "./failure.ts";

export interface DistillationCredentials {
  provider: string;
  credentials: ProviderCredentials | null;
  /** Best-effort USD per 1K completion tokens for usage accounting. */
  costPerKTokenOut?: number;
  /** Best-effort USD per 1K prompt tokens for usage accounting. */
  costPerKTokenIn?: number;
}

export interface ExecutorBreakerHook {
  /** Query the breaker for the named provider. Returns the open-state
   *  verdict + the suggested retry-after in ms. */
  isOpen(provider: string): Promise<{ open: boolean; retryAfterMs: number }>;
}

export interface ExecutorResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  /** Per-1k cost in USD for prompt completion tokens (optional). */
  costPerKTokenIn?: number;
  costPerKTokenOut?: number;
}

export interface ExecutorDeps {
  /** Adapter implemented by the integration owner — wraps the existing
   *  `createExecutorModelClient` (or a thinner inline call when the future
   *  tool loop is wired). */
  runModelCall(args: {
    provider: string;
    credentials: ProviderCredentials;
    model: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    maxTokens: number;
    isInternal: true;
    /** Signed no-memory/internal-call headers minted by the worker. */
    internalHeaders: Readonly<Record<string, string>>;
  }): Promise<ExecutorResult>;
  /** Adapter for the credentials resolver. The selected model is required so
   *  account selection honors per-model lockouts and quota windows. */
  resolveCredentials(provider: string, model: string): Promise<DistillationCredentials | null>;
  /** Adapter for the circuit breaker. */
  breaker: ExecutorBreakerHook;
  /** Optional override clock (tests only). */
  now?: () => number;
}

export interface ExecutorRunOutcome {
  status: "ok" | "breaker_open" | "model_unset" | "model_deleted" | "credentials_invalid" | "error";
  result?: ExecutorResult;
  /** Classified error on non-ok outcomes. */
  failure?: ReturnType<typeof classifyFailure>;
  /** When `status === "breaker_open"`, the suggested retry-after. */
  breakerRetryAfterMs?: number;
}

/**
 * Decide the next step for a claimed task. The caller passes the resolved
 * selection (provider + model + source from the selector); the executor
 * then performs the breaker check, credentials lookup, and the LLM call.
 */
export async function executeDistillationTask(args: {
  task: DistillationTask;
  provider: string;
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  maxTokens: number;
  internalHeaders: Readonly<Record<string, string>>;
  deps: ExecutorDeps;
}): Promise<ExecutorRunOutcome> {
  const { task, provider, model, messages, maxTokens, internalHeaders, deps } = args;

  // 1. Breaker check — never call the underlying executor when the provider
  //    breaker is OPEN. The worker re-queues without burning an attempt.
  const breaker = await deps.breaker.isOpen(provider);
  if (breaker.open) {
    return {
      status: "breaker_open",
      breakerRetryAfterMs: breaker.retryAfterMs,
    };
  }

  // 2. Credentials — same shape as the rest of the proxy. Null is a
  //    credentials_invalid failure, not a retryable error.
  const creds = await deps.resolveCredentials(provider, model);
  if (!creds || !creds.credentials) {
    return {
      status: "credentials_invalid",
      failure: classifyFailure(makeCodedError("CREDENTIALS_INVALID", "No credentials")),
    };
  }

  // 3. Run the call. The marker is implicit via `isInternal: true`; the
  //    runner adapter is responsible for attaching the X-Omniroute-No-Memory
  //    header + the HMAC marker (see internalMarker.ts).
  try {
    const result = await deps.runModelCall({
      provider,
      credentials: creds.credentials,
      model,
      messages,
      maxTokens,
      isInternal: true,
      internalHeaders,
    });
    return {
      status: "ok",
      result: {
        ...result,
        costPerKTokenIn: creds.costPerKTokenIn ?? result.costPerKTokenIn,
        costPerKTokenOut: creds.costPerKTokenOut ?? result.costPerKTokenOut,
      },
    };
  } catch (err) {
    return {
      status: "error",
      failure: classifyFailure(err),
    };
  }

  // The `task` parameter is intentionally threaded through so the runner
  // adapter can include the task id in the is_internal metadata. The
  // function does not mutate it, but the unused-binding lint keeps the
  // signature honest.
  void task;
}

export function makeCodedError(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code?: string };
  e.code = code;
  return e as Error & { code: string };
}

/**
 * Default breaker hook backed by the existing production circuit breaker.
 * Kept here (not in `worker.ts`) so the worker can be unit-tested with a
 * fake without dragging the breaker registry along.
 */
export function makeProductionBreakerHook(): ExecutorBreakerHook {
  return {
    async isOpen(provider: string) {
      try {
        const mod = (await import("@/shared/utils/circuitBreaker.ts" as string).catch(
          () => null
        )) as {
          getCircuitBreaker?: (name: string) => {
            getStatus: () => { state: string; retryAfterMs: number };
          };
        } | null;
        if (!mod?.getCircuitBreaker) return { open: false, retryAfterMs: 0 };
        const breaker = mod.getCircuitBreaker(`provider:${provider}`);
        const status = breaker.getStatus();
        return {
          open: status.state === "OPEN",
          retryAfterMs: status.retryAfterMs ?? 0,
        };
      } catch {
        return { open: false, retryAfterMs: 0 };
      }
    },
  };
}
