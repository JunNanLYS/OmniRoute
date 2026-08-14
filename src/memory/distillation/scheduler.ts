/**
 * Scheduling — pure helpers that decide the next back-off window per task kind.
 *
 * All functions are pure: the worker calls them on every retry/requeue and
 * persists the result. Keeping the math here (instead of inline at the call
 * site) means the boot docstring + the test list agree on the exact constants.
 *
 * Cadence (from PRD/Plan #10):
 *
 *   Warm-up ramp on success (helps cold-start a fresh provider pool):
 *     1s → 2s → 4s → 5s  (linear then capped; one-shot, NOT a recurrence)
 *   Idle back-off when there is no work:
 *     90s after the last successful poll.
 *   L2 (scene) scheduling:
 *     delay 10s after successful L1 distillation
 *     minimum 15min debounce between two scene distillations for the same scope
 *     maximum 60min hard cap; further scene requests fall into the L1 stream.
 *   L3 (persona): immediate — no debounce; persona drift is unbounded.
 *
 * Failure back-off (mirrors the documented retry policy):
 *   5s → 15s → 45s (cap). After the 3rd retry → DLQ.
 */

import type { DistillationTaskKind } from "./store.ts";

export const L1_IDLE_TIMEOUT_MS = 10 * 60_000;
export const L1_MAX_CONVERSATION_THRESHOLD = 5;
export const L1_READY_DELAY_MS = 1_000;
export const WARMUP_RAMP_MS: readonly number[] = Object.freeze([1000, 2000, 4000, 5000]);
export const IDLE_BACKOFF_MS = 90_000;
export const L2_INITIAL_DELAY_MS = 10_000;
export const L2_MIN_DEBOUNCE_MS = 15 * 60_000;
export const L2_MAX_DEBOUNCE_MS = 60 * 60_000;
export const L3_IMMEDIATE_DELAY_MS = 0;
export const RETRY_BACKOFF_MS: readonly number[] = Object.freeze([5_000, 15_000, 45_000]);
export const MAX_RETRY_ATTEMPTS = RETRY_BACKOFF_MS.length;

export function nextL1ConversationThreshold(completedRuns: number): number {
  const completed = Math.max(0, Math.floor(completedRuns));
  return Math.min(L1_MAX_CONVERSATION_THRESHOLD, 2 ** completed);
}

export function nextL1ScheduleMs(input: {
  roundsSinceLast: number;
  completedRuns: number;
  now: number;
}): number {
  const threshold = nextL1ConversationThreshold(input.completedRuns);
  return input.roundsSinceLast >= threshold
    ? input.now + L1_READY_DELAY_MS
    : input.now + L1_IDLE_TIMEOUT_MS;
}

export function nextWarmupDelayMs(consecutiveSuccesses: number): number {
  const idx = Math.min(Math.max(consecutiveSuccesses, 0), WARMUP_RAMP_MS.length - 1);
  return WARMUP_RAMP_MS[idx] as number;
}

export function isAtWarmupRamp(consecutiveSuccesses: number): boolean {
  return consecutiveSuccesses >= 0 && consecutiveSuccesses < WARMUP_RAMP_MS.length;
}

export function computeRetryBackoffMs(attempt: number): number {
  const idx = Math.min(Math.max(attempt, 0), RETRY_BACKOFF_MS.length - 1);
  return RETRY_BACKOFF_MS[idx] as number;
}

export function clampRetryAttempt(attempt: number): number {
  return Math.min(Math.max(attempt, 0), MAX_RETRY_ATTEMPTS);
}

/** Per-kind initial delay (epoch ms added to `now` for `notBefore`). */
export function initialDelayForKind(kind: DistillationTaskKind, now: number): number {
  switch (kind) {
    case "L1_extract":
      return now + nextWarmupDelayMs(0);
    case "L2_scene":
      return now + L2_INITIAL_DELAY_MS;
    case "L3_persona":
      return now + L3_IMMEDIATE_DELAY_MS;
    case "L0_chunk_embed":
      return now; // background chunk embeddings are not user-facing — immediate.
    default:
      return now;
  }
}

/**
 * Resolve the minimum interval between two scene distillations for the same
 * scope. Caller passes the last scene-fire epoch ms; 0 = no history.
 */
export function nextSceneScheduleMs(lastSceneFiredAtMs: number, now: number): number {
  if (!lastSceneFiredAtMs || lastSceneFiredAtMs <= 0) return now + L2_INITIAL_DELAY_MS;
  const earliestAllowed = lastSceneFiredAtMs + L2_MIN_DEBOUNCE_MS;
  const hardCap = lastSceneFiredAtMs + L2_MAX_DEBOUNCE_MS;
  // Once the hard cap has elapsed, the scene is already due. Return `now`
  // rather than a timestamp in the past so callers get an explicit
  // "run immediately" schedule.
  if (hardCap <= now) return now;
  return Math.min(Math.max(earliestAllowed, now + L2_INITIAL_DELAY_MS), hardCap);
}

/** True if the next scene fire should be deferred past `now`. */
export function shouldDeferScene(lastSceneFiredAtMs: number, now: number): boolean {
  return nextSceneScheduleMs(lastSceneFiredAtMs, now) > now;
}

/** Helper for the worker tick: how long to sleep when nothing was claimed. */
export function idleSleepMs(): number {
  return IDLE_BACKOFF_MS;
}
