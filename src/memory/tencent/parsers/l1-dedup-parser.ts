/**
 * L1 dedup action parser — adapted from TencentDB Agent Memory (MIT).
 *
 * Upstream source: derived from the dedup prompt contract in
 *   MemoryCore/src/core/prompts/l1-dedup.ts (CONFLICT_DETECTION_SYSTEM_PROMPT)
 *   and the action-application pattern in MemoryCore/src/core/record/l1-dedup.ts
 *
 * Local adaptation:
 *   - The upstream dedup runner is split into:
 *     (a) the prompt builder (see `../prompts/l1-dedup.ts`), and
 *     (b) this structured-action parser, suitable for in-memory / DB execution.
 *   - The "store|update|skip|merge" action enum is preserved verbatim.
 *   - `target_ids` arrays are preserved (multi-target merge support).
 *
 * Source commit: fe3230f Update package.json (TencentDB Agent Memory, MIT)
 *
 * ADAPTED FROM TencentDB Agent Memory (MIT). Copyright (C) 2026 Tencent.
 */

import { extractJson } from "./json-utils.js";

export type DedupAction = "store" | "update" | "skip" | "merge";

export const VALID_DEDUP_ACTIONS: ReadonlySet<string> = new Set([
  "store",
  "update",
  "skip",
  "merge",
]);

interface RawDedupDecision {
  record_id?: string;
  action?: string;
  target_ids?: string[] | null;
  merged_content?: string;
  merged_type?: string;
  merged_priority?: number | string;
  merged_timestamps?: string[];
}

export interface DedupDecision {
  record_id: string;
  action: DedupAction;
  target_ids: string[];
  /** Required for `merge`/`update`. */
  merged_content?: string;
  /** Required for `merge`/`update`. */
  merged_type?: string;
  /** Required for `merge`/`update`. Clamped to [0, 100]. */
  merged_priority?: number;
  /** Required for `merge`/`update`. */
  merged_timestamps?: string[];
}

/**
 * Coerce a possibly-string priority into an integer in [0, 100].
 * Returns undefined if the value is missing or non-numeric.
 */
function coercePriority(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(100, Math.round(value)));
  }
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.max(0, Math.min(100, Math.round(n)));
  }
  return undefined;
}

/**
 * Parse the L1 batch dedup response into structured decisions.
 *
 * - Entries with invalid `record_id` or `action` are dropped.
 * - `store` / `skip` carry no `merged_*` payload; if the LLM emits them
 *   anyway they are ignored.
 * - `merge` / `update` accept partial `merged_*` payloads (missing fields are
 *   left undefined so the caller can decide what to do).
 */
export function parseL1DedupResponse(raw: string): DedupDecision[] {
  const parsed = extractJson<RawDedupDecision[]>(raw);
  if (!parsed || !Array.isArray(parsed)) return [];

  const decisions: DedupDecision[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;

    const recordId = typeof item.record_id === "string" ? item.record_id : "";
    if (!recordId) continue;

    const action = typeof item.action === "string" ? item.action.toLowerCase() : "";
    if (!VALID_DEDUP_ACTIONS.has(action)) continue;

    const decision: DedupDecision = {
      record_id: recordId,
      action: action as DedupAction,
      target_ids: Array.isArray(item.target_ids)
        ? item.target_ids.filter((id): id is string => typeof id === "string")
        : [],
    };

    if (action === "merge" || action === "update") {
      if (typeof item.merged_content === "string") {
        decision.merged_content = item.merged_content;
      }
      if (typeof item.merged_type === "string") {
        decision.merged_type = item.merged_type;
      }
      const pri = coercePriority(item.merged_priority);
      if (pri !== undefined) {
        decision.merged_priority = pri;
      }
      if (Array.isArray(item.merged_timestamps)) {
        decision.merged_timestamps = item.merged_timestamps
          .filter((t): t is string => typeof t === "string")
          .map((t) => t);
      }
    }

    decisions.push(decision);
  }
  return decisions;
}
