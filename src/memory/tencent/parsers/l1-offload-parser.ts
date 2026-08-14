/**
 * L1 offload entry parser — adapted from TencentDB Agent Memory (MIT).
 *
 * Upstream source:
 *   MemoryCore/src/offload/local-llm/parsers/l1-parser.ts
 *   MemoryCore/src/offload_server/parsers/l1-parser.ts
 *
 * Source commit: fe3230f Update package.json (TencentDB Agent Memory, MIT)
 *
 * ADAPTED FROM TencentDB Agent Memory (MIT). Copyright (C) 2026 Tencent.
 */

import { extractJson } from "./json-utils.js";

interface RawL1Entry {
  tool_call?: string;
  summary?: string;
  tool_call_id?: string;
  timestamp?: string;
  score?: number;
}

export interface ParsedL1Entry {
  tool_call_id: string;
  tool_call: string;
  summary: string;
  timestamp: string;
  /** Clamped to [0, 10]. Defaults to 5 if absent or non-numeric. */
  score: number;
  node_id: string | null;
}

/**
 * Parse L1 LLM response into a structured entry array.
 *
 * Tolerant of markdown wrapping, missing fields, etc. Entries without a
 * `tool_call_id` are dropped (the id is the join key for downstream stages).
 */
export function parseL1OffloadResponse(raw: string): ParsedL1Entry[] {
  const parsed = extractJson<RawL1Entry[]>(raw);
  if (!parsed || !Array.isArray(parsed)) return [];

  const entries: ParsedL1Entry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;

    const toolCallId = item.tool_call_id ?? "";
    if (!toolCallId) continue; // required

    let score = 5;
    if (typeof item.score === "number") {
      score = Math.min(10, Math.max(0, item.score));
    }

    entries.push({
      tool_call_id: toolCallId,
      tool_call: item.tool_call ?? "",
      summary: item.summary ?? "",
      timestamp: item.timestamp ?? "",
      score,
      node_id: null,
    });
  }

  return entries;
}
