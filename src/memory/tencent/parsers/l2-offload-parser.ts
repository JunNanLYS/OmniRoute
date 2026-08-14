/**
 * L2 offload MMD parser — adapted from TencentDB Agent Memory (MIT).
 *
 * Upstream source:
 *   MemoryCore/src/offload_server/parsers/l2-parser.ts
 *     (parseL2Response, RawL2Response)
 *
 * Source commit: fe3230f Update package.json (TencentDB Agent Memory, MIT)
 *
 * ADAPTED FROM TencentDB Agent Memory (MIT). Copyright (C) 2026 Tencent.
 */

import { extractJson, extractMermaidFromFence } from "./json-utils.js";

export interface L2ReplaceBlock {
  startLine: number;
  endLine: number;
  content: string;
}

export interface L2ParsedResponse {
  fileAction: "write" | "replace";
  /** Raw mermaid body for `write` actions. Undefined for `replace`. */
  mmdContent?: string;
  /** Block updates for `replace` actions. Undefined for `write`. */
  replaceBlocks?: L2ReplaceBlock[];
  /** tool_call_id → MMD node id. */
  nodeMapping: Record<string, string>;
}

interface RawL2Response {
  file_action?: string;
  mmd_content?: string | null;
  replace_blocks?: Array<{
    start_line?: number | string;
    end_line?: number | string;
    content?: string;
  }> | null;
  node_mapping?: Record<string, string>;
}

/**
 * Parse L2 LLM response into a structured action.
 *
 * Behavior parity with upstream:
 *   - Non-`replace` file_action defaults to "write"
 *   - mmd_content for `write` is unwrapped from ```mermaid fences
 *   - replace_blocks entries with non-numeric start/end line are dropped
 *   - bare ```mermaid``` block fallback when JSON parsing fails entirely
 */
export function parseL2OffloadResponse(raw: string): L2ParsedResponse | null {
  const parsed = extractJson<RawL2Response>(raw);
  if (!parsed || typeof parsed !== "object") {
    const mmd = extractMermaidFromFence(raw);
    if (mmd) {
      return { fileAction: "write", mmdContent: mmd, nodeMapping: {} };
    }
    return null;
  }

  const fileAction = parsed.file_action === "replace" ? "replace" : "write";

  let mmdContent: string | undefined;
  if (fileAction === "write") {
    if (parsed.mmd_content) {
      mmdContent = extractMermaidFromFence(parsed.mmd_content) ?? parsed.mmd_content;
    } else {
      const fallbackMmd = extractMermaidFromFence(raw);
      if (fallbackMmd) mmdContent = fallbackMmd;
    }
  }

  let replaceBlocks: L2ReplaceBlock[] | undefined;
  if (fileAction === "replace" && Array.isArray(parsed.replace_blocks)) {
    replaceBlocks = [];
    for (const block of parsed.replace_blocks) {
      if (!block || typeof block !== "object") continue;
      const startLine = Number(block.start_line);
      const endLine = Number(block.end_line);
      if (isNaN(startLine) || isNaN(endLine)) continue;

      let content = block.content ?? "";
      const extracted = extractMermaidFromFence(content);
      if (extracted) content = extracted;

      replaceBlocks.push({ startLine, endLine, content });
    }
  }

  const nodeMapping: Record<string, string> = {};
  if (parsed.node_mapping && typeof parsed.node_mapping === "object") {
    for (const [key, value] of Object.entries(parsed.node_mapping)) {
      if (typeof value === "string") {
        nodeMapping[key] = value;
      }
    }
  }

  return { fileAction, mmdContent, replaceBlocks, nodeMapping };
}
