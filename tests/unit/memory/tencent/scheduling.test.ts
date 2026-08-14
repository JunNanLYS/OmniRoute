/**
 * Tests for L1/L2/L3 scheduling helpers — `src/memory/tencent/scheduling/pipeline.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  shouldTriggerL1,
  shouldTriggerL2,
  shouldTriggerL3,
  advanceWarmup,
  DEFAULT_EVERY_N_CONVERSATIONS,
  DEFAULT_L3_EVERY_N_SCENES,
  DEFAULT_L3_MIN_MEMORIES_SINCE,
  type PipelineSessionState,
} from "../../../../src/memory/tencent/index.js";

function makeState(overrides: Partial<PipelineSessionState> = {}): PipelineSessionState {
  return {
    conversation_count: 0,
    last_extraction_time: "",
    last_extraction_updated_time: "",
    last_active_time: 0,
    l2_pending_l1_count: 0,
    warmup_threshold: 0,
    l2_last_extraction_time: "",
    ...overrides,
  };
}

describe("advanceWarmup", () => {
  it("doubles warmup_threshold from 1 → 2 → 4 → 8 → ...", () => {
    let s = makeState({ warmup_threshold: 1 });
    s = advanceWarmup(s, 10);
    assert.equal(s.warmup_threshold, 2);
    s = advanceWarmup(s, 10);
    assert.equal(s.warmup_threshold, 4);
    s = advanceWarmup(s, 10);
    assert.equal(s.warmup_threshold, 8);
  });

  it("saturates to 0 when next double would exceed everyN", () => {
    let s = makeState({ warmup_threshold: 8 });
    s = advanceWarmup(s, 10); // 8*2=16 ≥ 10 → saturate to 0
    assert.equal(s.warmup_threshold, 0);
  });

  it("treats 0 as 'graduated' and starts the ladder from everyN", () => {
    let s = makeState({ warmup_threshold: 0 }); // graduated
    s = advanceWarmup(s, 10); // saturated → stays at 0
    assert.equal(s.warmup_threshold, 0);
  });
});

describe("shouldTriggerL1", () => {
  it("triggers when conversation_count >= warmup threshold", () => {
    const s = makeState({ warmup_threshold: 1 });
    assert.equal(shouldTriggerL1(1, s, 10), true);
    assert.equal(shouldTriggerL1(0, s, 10), false);
  });

  it("uses everyN when warmup is graduated (0)", () => {
    const s = makeState({ warmup_threshold: 0 });
    assert.equal(shouldTriggerL1(9, s, 10), false);
    assert.equal(shouldTriggerL1(10, s, 10), true);
  });
});

describe("shouldTriggerL2", () => {
  it("triggers when conversation_count reaches everyN", () => {
    const s = makeState({ conversation_count: 10, warmup_threshold: 0 });
    assert.equal(shouldTriggerL2(s, 10), true);
  });

  it("respects the warmup ladder (early triggers)", () => {
    // First session: warmup_threshold=1 → fire after 1 conversation
    const s = makeState({ conversation_count: 1, warmup_threshold: 1 });
    assert.equal(shouldTriggerL2(s, 10), true);
  });

  it("does not trigger before threshold", () => {
    const s = makeState({ conversation_count: 5, warmup_threshold: 0 });
    assert.equal(shouldTriggerL2(s, 10), false);
  });
});

describe("shouldTriggerL3", () => {
  it("triggers by scene-count signal", () => {
    const out = shouldTriggerL3({
      sceneCount: 10,
      lastL3AtSceneCount: 5,
      memoriesSinceLastPersona: 0,
    });
    assert.equal(out.trigger, true);
    assert.equal(out.reason, "scenes");
  });

  it("triggers by memories signal when scene count is flat", () => {
    const out = shouldTriggerL3({
      sceneCount: 0,
      lastL3AtSceneCount: 0,
      memoriesSinceLastPersona: DEFAULT_L3_MIN_MEMORIES_SINCE,
    });
    assert.equal(out.trigger, true);
    assert.equal(out.reason, "memories");
  });

  it("returns no-trigger when both signals are below threshold", () => {
    const out = shouldTriggerL3({
      sceneCount: 1,
      lastL3AtSceneCount: 0,
      memoriesSinceLastPersona: 1,
      everyNScenes: DEFAULT_L3_EVERY_N_SCENES,
      minMemoriesSincePersona: DEFAULT_L3_MIN_MEMORIES_SINCE,
    });
    assert.equal(out.trigger, false);
    assert.equal(out.reason, "none");
  });

  it("uses default constants", () => {
    assert.equal(DEFAULT_EVERY_N_CONVERSATIONS, 10);
    assert.equal(DEFAULT_L3_EVERY_N_SCENES, 5);
    assert.equal(DEFAULT_L3_MIN_MEMORIES_SINCE, 20);
  });
});
