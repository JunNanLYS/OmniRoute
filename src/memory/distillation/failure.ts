/**
 * Failure classification + retry/DLQ policy.
 *
 * Five buckets, mapped from the upstream error shape:
 *
 *   1. retry_429     — HTTP 429 from the provider. Retried up to MAX_RETRY
 *                      attempts with the configured backoff.
 *   2. retry_5xx     — HTTP 5xx or transient transport error. Same retry
 *                      policy as 429.
 *   3. retry_network — DNS / ECONNRESET / timeout. Same retry policy.
 *   4. no_retry_4xx  — HTTP 4xx that is not 429 (model gone, bad request,
 *                      invalid key, …). NO retry; goes straight to DLQ with
 *                      a model-lockout hint so the selector skips that
 *                      provider/model on the next round.
 *   5. parse_failed  — the LLM responded but the parser rejected the
 *                      shape. NO retry on the upstream; L0 regex fallback
 *                      is recorded only as L0 evidence. DLQ.
 *   6. semantic_invalid — content safety / instruction conflict / refusal.
 *                      DLQ.
 *   7. budget_exceeded — our own caps (steps / tokens / calls / depth) were
 *                      exceeded. DLQ.
 *   8. model_unset   — selector could not resolve any provider/model. DLQ.
 *   9. model_deleted — runtime catalog check rejected the selected model. DLQ.
 *  10. credentials_invalid — credentials resolver returned null. DLQ.
 *
 * Sanitized error messages are written back into the task + DLQ. Raw stacks,
 * raw upstream bodies, and credentials are NEVER persisted.
 */

import { MAX_RETRY_ATTEMPTS } from "./scheduler.ts";
import type { DistillationDLQEntry } from "./store.ts";

export type FailureKind =
  | "retry_429"
  | "retry_5xx"
  | "retry_network"
  | "retry_storage"
  | "no_retry_4xx"
  | "parse_failed"
  | "semantic_invalid"
  | "budget_exceeded"
  | "model_unset"
  | "model_deleted"
  | "credentials_invalid";

export interface ClassifiedError {
  kind: FailureKind;
  retryable: boolean;
  /** True when the underlying provider/model should be locked out. */
  triggersModelLockout: boolean;
  /** Sanitized, length-capped message for storage. */
  message: string;
}

export const MAX_STORED_ERROR_LENGTH = 500;

/** Detect a numeric HTTP status from anything thrown by the executor. */
export function extractStatusCode(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const candidates: unknown[] = [
    (err as { status?: unknown }).status,
    (err as { statusCode?: unknown }).statusCode,
    (err as { response?: { status?: unknown } }).response?.status,
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c >= 100 && c < 600) return c;
  }
  if (typeof (err as { code?: unknown }).code === "string") {
    const m = (err as { code: string }).code.match(/^HTTP_(\d{3})$/);
    if (m && m[1]) return Number(m[1]);
  }
  return null;
}

/** Detect a network-class error (Node-style codes). */
const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export function isNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
  const name = (err as { name?: unknown }).name;
  if (typeof name === "string" && (name === "AbortError" || name === "TimeoutError")) return true;
  const message = readMessage(err);
  if (!message) return false;
  return /timeout/i.test(message) || /socket hang up/i.test(message) || /network/i.test(message);
}

function readMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (
    err &&
    typeof err === "object" &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return "";
}

/**
 * Classify an arbitrary thrown value. The "kind" is one of the 10 buckets;
 * "retryable" and "triggersModelLockout" are derived policy flags.
 */
export function classifyFailure(err: unknown): ClassifiedError {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") {
      if (code === "BUDGET_EXCEEDED") {
        return {
          kind: "budget_exceeded",
          retryable: false,
          triggersModelLockout: false,
          message: "Distillation budget exceeded (steps/tokens/calls/depth).",
        };
      }
      if (code === "MODEL_UNSET") {
        return {
          kind: "model_unset",
          retryable: false,
          triggersModelLockout: false,
          message: "No provider/model could be resolved for this task.",
        };
      }
      if (code === "MODEL_DELETED") {
        return {
          kind: "model_deleted",
          retryable: false,
          triggersModelLockout: true,
          message: "Selected provider/model no longer exists in the runtime catalog.",
        };
      }
      if (code === "CREDENTIALS_INVALID") {
        return {
          kind: "credentials_invalid",
          retryable: false,
          triggersModelLockout: false,
          message: "Credentials resolver returned no usable connection.",
        };
      }
      if (code === "PARSE_FAILED") {
        return {
          kind: "parse_failed",
          retryable: false,
          triggersModelLockout: false,
          message: "LLM response could not be parsed.",
        };
      }
      if (code === "SEMANTIC_INVALID") {
        return {
          kind: "semantic_invalid",
          retryable: false,
          triggersModelLockout: false,
          message: "LLM refused or produced invalid content.",
        };
      }
    }
  }

  const status = extractStatusCode(err);
  if (status === 429) {
    return {
      kind: "retry_429",
      retryable: true,
      triggersModelLockout: false,
      message: sanitizeMessage(`HTTP 429 from upstream: ${readMessage(err)}`),
    };
  }
  if (status !== null && status >= 500 && status < 600) {
    return {
      kind: "retry_5xx",
      retryable: true,
      triggersModelLockout: false,
      message: sanitizeMessage(`HTTP ${status} from upstream`),
    };
  }
  if (status !== null && status >= 400 && status < 500) {
    return {
      kind: "no_retry_4xx",
      retryable: false,
      triggersModelLockout: true,
      message: sanitizeMessage(`HTTP ${status} from upstream`),
    };
  }
  if (isNetworkError(err)) {
    return {
      kind: "retry_network",
      retryable: true,
      triggersModelLockout: false,
      message: sanitizeMessage(readMessage(err) || "Network error"),
    };
  }
  // Unknown → conservative no-retry. We do not silently retry errors we cannot
  // classify because that would let the same bug burn three attempts before
  // landing in the DLQ.
  return {
    kind: "no_retry_4xx",
    retryable: false,
    triggersModelLockout: false,
    message: sanitizeMessage(readMessage(err) || "Unknown failure"),
  };
}

/**
 * Cap the stored message length AND strip anything that looks like a stack
 * frame, a credentials blob (Bearer tokens, api_key=…), or a path.
 */
export function sanitizeMessage(raw: string): string {
  let s = typeof raw === "string" ? raw : "";
  // Drop stack frames ("at /workspace/…", "at fn (file.ts:1:1)").
  s = s.replace(/\s+at\s+[^\n]+/g, " ");
  // Drop credentials-looking fragments. Conservative — better to over-strip
  // than leak a key into the DLQ. `authorization` is deliberately NOT in the
  // assignment group: "Authorization: Bearer …" is handled by the Bearer
  // regex above, and including it here would swallow "Bearer" itself after
  // the value regex consumed the token.
  s = s.replace(/\bBearer\s+[A-Za-z0-9._\-+/=]+/g, "Bearer <redacted>");
  s = s.replace(/\b(api[_-]?key|access[_-]?token)\s*[:=]\s*["']?[^\s"',;]+/gi, "$1=<redacted>");
  // Drop filesystem paths.
  s = s.replace(/(?:\/|[A-Za-z]:\\)[\w./\\-]+/g, "<path>");
  // Collapse whitespace.
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > MAX_STORED_ERROR_LENGTH) s = s.slice(0, MAX_STORED_ERROR_LENGTH) + "…";
  return s;
}

export interface RetryDecision {
  retry: boolean;
  /** Backoff in ms (only meaningful when `retry === true`). */
  backoffMs: number;
  /** The next attempt number (always `attempt + 1` when retrying). */
  nextAttempt: number;
  /** True when the failure kind DLQs. */
  dlq: boolean;
  /** The DLQ kind, if any. */
  dlqKind: DistillationDLQEntry["failureKind"];
}

export function decideRetry(failure: ClassifiedError, attempt: number): RetryDecision {
  if (!failure.retryable) {
    return {
      retry: false,
      backoffMs: 0,
      nextAttempt: attempt,
      dlq: true,
      dlqKind: mapDlqKind(failure.kind),
    };
  }
  if (attempt >= MAX_RETRY_ATTEMPTS) {
    return {
      retry: false,
      backoffMs: 0,
      nextAttempt: attempt,
      dlq: true,
      dlqKind: mapDlqKind(failure.kind),
    };
  }
  const backoffMs = computeBackoffForRetry(attempt);
  return {
    retry: true,
    backoffMs,
    nextAttempt: attempt + 1,
    dlq: false,
    dlqKind: "retry_exhausted",
  };
}

function mapDlqKind(kind: FailureKind): DistillationDLQEntry["failureKind"] {
  switch (kind) {
    case "retry_429":
    case "retry_5xx":
    case "retry_network":
    case "retry_storage":
      return "retry_exhausted";
    case "no_retry_4xx":
      return "no_retry";
    case "parse_failed":
      return "parse_failed";
    case "semantic_invalid":
      return "semantic_invalid";
    case "budget_exceeded":
      return "budget_exceeded";
    case "model_unset":
      return "model_unset";
    case "model_deleted":
      return "model_deleted";
    case "credentials_invalid":
      return "credentials_invalid";
    default:
      return "no_retry";
  }
}

function computeBackoffForRetry(attempt: number): number {
  // Same backoff table as scheduler.computeRetryBackoffMs but inlined so the
  // decision function does not depend on the scheduler (avoids a circular
  // import in tests where scheduler is replaced).
  const table = [5_000, 15_000, 45_000];
  const idx = Math.min(Math.max(attempt, 0), table.length - 1);
  return table[idx] as number;
}
