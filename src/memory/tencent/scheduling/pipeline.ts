/**
 * L1/L2/L3 scheduling helpers — adapted from TencentDB Agent Memory (MIT).
 *
 * Upstream source:
 *   MemoryCore/src/utils/checkpoint.ts
 *     (PipelineSessionState, getPipelineState, warmup_threshold semantics)
 *   MemoryCore/src/core/state/types.ts
 *   MemoryCore/src/core/store/embedding.ts (warmup)
 *
 * Local adaptation:
 *   - The upstream `warmup_threshold` doubling ladder
 *     (1 → 2 → 4 → 8 → ... → everyNConversations) is extracted into pure
 *     logic, with default `everyNConversations=10` and `maxScenes=15`.
 *   - L2 scheduling (every N conversations, gated by warmup) is exposed
 *     as `shouldTriggerL2`.
 *   - L3 scheduling (every N scenes OR after memoriesSinceLastPersona ≥ T)
 *     is exposed as `shouldTriggerL3`.
 *   - All checks are pure: no I/O, no checkpoint file, no DB writes.
 *
 * Source commit: fe3230f Update package.json (TencentDB Agent Memory, MIT)
 *
 * ADAPTED FROM TencentDB Agent Memory (MIT). Copyright (C) 2026 Tencent.
 */

/** Per-session pipeline state slice this module cares about. */
export interface PipelineSessionState {
  /** Conversation rounds since last L1 trigger. */
  conversation_count: number;
  /** ISO timestamp of the last extraction completion. */
  last_extraction_time: string;
  /** ISO timestamp cursor for incremental extraction reads. */
  last_extraction_updated_time: string;
  /** Epoch ms of the last notifyConversation call. */
  last_active_time: number;
  /** Mirrors conversation_count at L1 completion time (for L2 tracking). */
  l2_pending_l1_count: number;
  /**
   * Current warm-up threshold for L1/L2 triggering.
   * Starts at 1 for new sessions and doubles after each L1 completion
   * (1 → 2 → 4 → 8 → ...) until it reaches everyNConversations.
   * 0 means warm-up is complete (use everyNConversations directly).
   */
  warmup_threshold: number;
  /** ISO timestamp of last L2 extraction completion. */
  l2_last_extraction_time: string;
}

/** Pipeline scheduling defaults — mirrors upstream defaults. */
export const DEFAULT_EVERY_N_CONVERSATIONS = 10;
/** L3 trigger: trigger after every N scenes processed. */
export const DEFAULT_L3_EVERY_N_SCENES = 5;
/** L3 trigger: trigger after N memories accumulated since last L3 run. */
export const DEFAULT_L3_MIN_MEMORIES_SINCE = 20;

/** Advance the warmup ladder one step. Mirrors upstream doubling rule. */
export function advanceWarmup(state: PipelineSessionState, everyN: number): PipelineSessionState {
  const current = state.warmup_threshold > 0 ? state.warmup_threshold : everyN;
  const next = current * 2;
  const saturated = next >= everyN;
  return {
    ...state,
    warmup_threshold: saturated ? 0 : next,
  };
}

/**
 * Decide whether to trigger L2 now.
 *
 * Pure function. Mirrors upstream PipelineManager semantics: L2 fires after
 * every `everyNConversations` completed L1 extractions, with the warmup
 * ladder gating the early triggers.
 */
export function shouldTriggerL2(
  state: PipelineSessionState,
  everyN: number = DEFAULT_EVERY_N_CONVERSATIONS
): boolean {
  const threshold = state.warmup_threshold > 0 ? state.warmup_threshold : everyN;
  return state.conversation_count >= threshold;
}

/**
 * Decide whether to trigger L3 now.
 *
 * Triggers when EITHER:
 *   - the scene count has advanced by `everyNScenes` since the last trigger
 *     (cheap proxy for "material change"), OR
 *   - `memoriesSinceLastPersona ≥ minMemoriesSincePersona` (raw memory pressure).
 *
 * The caller decides which signal to honour when both fire.
 */
export function shouldTriggerL3(params: {
  sceneCount: number;
  /** Total scenes processed at last L3 trigger. */
  lastL3AtSceneCount: number;
  memoriesSinceLastPersona: number;
  everyNScenes?: number;
  minMemoriesSincePersona?: number;
}): { trigger: boolean; reason: "scenes" | "memories" | "none" } {
  const every = params.everyNScenes ?? DEFAULT_L3_EVERY_N_SCENES;
  const minMem = params.minMemoriesSincePersona ?? DEFAULT_L3_MIN_MEMORIES_SINCE;

  if (params.sceneCount - params.lastL3AtSceneCount >= every) {
    return { trigger: true, reason: "scenes" };
  }
  if (params.memoriesSinceLastPersona >= minMem) {
    return { trigger: true, reason: "memories" };
  }
  return { trigger: false, reason: "none" };
}

/**
 * Decide whether L1 should fire for an incoming conversation. Mirrors the
 * warmup semantics: the threshold doubles after each completion until it
 * reaches `everyN`.
 *
 * `conversation_count` here is the caller's local counter — the caller is
 * expected to update pipeline state outside this module.
 */
export function shouldTriggerL1(
  conversationCount: number,
  state: PipelineSessionState,
  everyN: number = DEFAULT_EVERY_N_CONVERSATIONS
): boolean {
  const threshold = state.warmup_threshold > 0 ? state.warmup_threshold : everyN;
  return conversationCount >= threshold;
}
