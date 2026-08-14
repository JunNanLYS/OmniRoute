/**
 * Tolerant JSON parsing utilities for LLM responses — adapted from
 * TencentDB Agent Memory (MIT).
 *
 * Upstream source:
 *   MemoryCore/src/offload/local-llm/parsers/json-utils.ts
 *     (extractJson, extractMermaidFromFence, tryParse, fixTrailingCommas)
 *   MemoryCore/src/offload_server/parsers/json-utils.ts (identical mirror)
 *
 * Local adaptation:
 *   - Strategy order (direct → markdown fence → first/last brace → first/last
 *     bracket → trailing-comma fix) is preserved.
 *   - The Chinese-language tool-call-id comment is dropped (no functional effect).
 *
 * Source commit: fe3230f Update package.json (TencentDB Agent Memory, MIT)
 *
 * ADAPTED FROM TencentDB Agent Memory (MIT). Copyright (C) 2026 Tencent.
 */

/**
 * Extract JSON from LLM output — handles code fences, prefix text, etc.
 * Returns the parsed object/array, or null if parsing fails.
 */
export function extractJson<T = unknown>(raw: string): T | null {
  if (!raw || typeof raw !== "string") return null;

  const trimmed = raw.trim();

  // Strategy 1: Direct parse (ideal case)
  const direct = tryParse<T>(trimmed);
  if (direct !== null) return direct;

  // Strategy 2: Extract from markdown code fence (```json ... ``` or ``` ... ```)
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    const inner = fenceMatch[1].trim();
    const parsed = tryParse<T>(inner);
    if (parsed !== null) return parsed;
  }

  // Strategy 3: Find first { to last } (or first [ to last ])
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    const parsed = tryParse<T>(candidate);
    if (parsed !== null) return parsed;

    const fixed = fixTrailingCommas(candidate);
    const parsedFixed = tryParse<T>(fixed);
    if (parsedFixed !== null) return parsedFixed;
  }

  const firstBracket = trimmed.indexOf("[");
  const lastBracket = trimmed.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    const candidate = trimmed.slice(firstBracket, lastBracket + 1);
    const parsed = tryParse<T>(candidate);
    if (parsed !== null) return parsed;
  }

  // Strategy 4: Try fixing the entire string
  const fixed = fixTrailingCommas(trimmed);
  const parsedFixed = tryParse<T>(fixed);
  if (parsedFixed !== null) return parsedFixed;

  return null;
}

/**
 * Extract mermaid content from a code fence.
 * Returns the raw mermaid text (without fence markers), or null.
 */
export function extractMermaidFromFence(text: string): string | null {
  if (!text) return null;
  const match = text.match(/```mermaid\s*\n?([\s\S]*?)```/);
  if (match) return match[1].trim();
  if (text.includes("flowchart") || text.includes("graph")) return text.trim();
  return null;
}

function tryParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function fixTrailingCommas(s: string): string {
  return s.replace(/,\s*([}\]])/g, "$1");
}
