import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  WARMUP_RAMP_MS,
  IDLE_BACKOFF_MS,
  L1_IDLE_TIMEOUT_MS,
  L1_MAX_CONVERSATION_THRESHOLD,
  L2_INITIAL_DELAY_MS,
  L2_MIN_DEBOUNCE_MS,
  L3_IMMEDIATE_DELAY_MS,
  RETRY_BACKOFF_MS,
  MAX_RETRY_ATTEMPTS,
  nextWarmupDelayMs,
  isAtWarmupRamp,
  computeRetryBackoffMs,
  clampRetryAttempt,
  initialDelayForKind,
  nextL1ConversationThreshold,
  nextL1ScheduleMs,
  nextSceneScheduleMs,
  shouldDeferScene,
  idleSleepMs,
} from "../../../../src/memory/distillation/scheduler.ts";

describe("distillation/scheduler — warm-up ramp", () => {
  it("follows 1s → 2s → 4s → 5s then caps", () => {
    assert.deepEqual([...WARMUP_RAMP_MS], [1000, 2000, 4000, 5000]);
    assert.equal(nextWarmupDelayMs(0), 1000);
    assert.equal(nextWarmupDelayMs(1), 2000);
    assert.equal(nextWarmupDelayMs(2), 4000);
    assert.equal(nextWarmupDelayMs(3), 5000);
    assert.equal(nextWarmupDelayMs(99), 5000);
  });

  it("isAtWarmupRamp is true on the first few consecutive successes", () => {
    assert.equal(isAtWarmupRamp(0), true);
    assert.equal(isAtWarmupRamp(3), true);
    assert.equal(isAtWarmupRamp(4), false);
  });
});

describe("distillation/scheduler — L1 conversation cadence", () => {
  it("ramps thresholds 1 → 2 → 4 → 5 and then caps", () => {
    assert.equal(L1_MAX_CONVERSATION_THRESHOLD, 5);
    assert.equal(nextL1ConversationThreshold(0), 1);
    assert.equal(nextL1ConversationThreshold(1), 2);
    assert.equal(nextL1ConversationThreshold(2), 4);
    assert.equal(nextL1ConversationThreshold(4), 5);
    assert.equal(nextL1ConversationThreshold(99), 5);
  });

  it("fires quickly at threshold and otherwise uses the 10 minute idle debounce", () => {
    const now = 1_000_000;
    assert.equal(L1_IDLE_TIMEOUT_MS, 600_000);
    assert.equal(nextL1ScheduleMs({ roundsSinceLast: 1, completedRuns: 0, now }), now + 1_000);
    assert.equal(
      nextL1ScheduleMs({ roundsSinceLast: 1, completedRuns: 1, now }),
      now + L1_IDLE_TIMEOUT_MS
    );
    assert.equal(nextL1ScheduleMs({ roundsSinceLast: 2, completedRuns: 1, now }), now + 1_000);
  });
});

describe("distillation/scheduler — idle back-off", () => {
  it("idle sleep is 90s", () => {
    assert.equal(idleSleepMs(), IDLE_BACKOFF_MS);
    assert.equal(IDLE_BACKOFF_MS, 90_000);
  });
});

describe("distillation/scheduler — L2 debounce", () => {
  it("initial fire is now + 10s when no history", () => {
    const now = 1_000_000;
    assert.equal(L2_INITIAL_DELAY_MS, 10_000);
    assert.equal(nextSceneScheduleMs(0, now), now + L2_INITIAL_DELAY_MS);
  });

  it("respects the 15-min minimum debounce between two scene fires", () => {
    const now = 1_000_000;
    const last = now - 60_000; // last fired 1m ago
    const next = nextSceneScheduleMs(last, now);
    assert.ok(next >= last + L2_MIN_DEBOUNCE_MS);
    assert.ok(shouldDeferScene(last, now));
  });

  it("fires immediately after the 60-min hard cap has elapsed", () => {
    const now = 100_000_000;
    const last = now - 24 * 60 * 60_000; // 1 day ago
    const next = nextSceneScheduleMs(last, now);
    assert.equal(next, now);
    assert.equal(shouldDeferScene(last, now), false);
  });
});

describe("distillation/scheduler — L3 immediate", () => {
  it("L3 fires now (zero delay)", () => {
    const t = initialDelayForKind("L3_persona", 1_000_000);
    assert.equal(t - 1_000_000, L3_IMMEDIATE_DELAY_MS);
    assert.equal(L3_IMMEDIATE_DELAY_MS, 0);
  });
});

describe("distillation/scheduler — retry back-off", () => {
  it("follows 5s → 15s → 45s", () => {
    assert.deepEqual([...RETRY_BACKOFF_MS], [5000, 15000, 45000]);
    assert.equal(computeRetryBackoffMs(0), 5000);
    assert.equal(computeRetryBackoffMs(1), 15000);
    assert.equal(computeRetryBackoffMs(2), 45000);
    assert.equal(computeRetryBackoffMs(99), 45000);
  });
  it("clampRetryAttempt bounds to [0, MAX]", () => {
    assert.equal(clampRetryAttempt(-1), 0);
    assert.equal(clampRetryAttempt(0), 0);
    assert.equal(clampRetryAttempt(MAX_RETRY_ATTEMPTS), MAX_RETRY_ATTEMPTS);
    assert.equal(clampRetryAttempt(MAX_RETRY_ATTEMPTS + 100), MAX_RETRY_ATTEMPTS);
  });
});
