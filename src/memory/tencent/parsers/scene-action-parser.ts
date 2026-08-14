/**
 * L2 scene-action parser — adapted from TencentDB Agent Memory (MIT).
 *
 * Upstream source: derived from the L2 scene-extraction prompt contract in
 *   MemoryCore/src/core/prompts/scene-extraction.ts and the runtime contract
 *   in MemoryCore/src/core/scene/scene-extractor.ts
 *
 * Local adaptation:
 *   - The upstream scene-extractor performs tool calls (read/write/edit)
 *     against a sandboxed `scene_blocks/` directory and parses the trace to
 *     recover file operations. This port skips the tool-call layer entirely
 *     and returns a structured action list directly so the OmniRoute native
 *     worker can persist the result via its own DB layer.
 *   - The UPDATE > MERGE > CREATE priority order and the `[DELETED]` marker
 *     are preserved as constants.
 *   - The persona-update-request out-of-band signal is preserved.
 *
 * Source commit: fe3230f Update package.json (TencentDB Agent Memory, MIT)
 *
 * ADAPTED FROM TencentDB Agent Memory (MIT). Copyright (C) 2026 Tencent.
 */

import { extractJson, extractMermaidFromFence } from "./json-utils.js";

export type SceneActionKind = "update" | "merge" | "create";

/** Action priority: UPDATE > MERGE > CREATE. Mirrors upstream "默认策略是 UPDATE". */
export const SCENE_ACTION_PRIORITY: Record<SceneActionKind, number> = {
  update: 0,
  merge: 1,
  create: 2,
};

/** Marker that the upstream extractor uses to soft-delete a scene file. */
export const SCENE_DELETED_MARKER = "[DELETED]";

/** Out-of-band persona-update signal. */
export const PERSONA_UPDATE_REQUEST_OPEN = "[PERSONA_UPDATE_REQUEST]";
export const PERSONA_UPDATE_REQUEST_CLOSE = "[/PERSONA_UPDATE_REQUEST]";

export interface SceneUpdateAction {
  kind: "update";
  /** Existing scene filename to overwrite. */
  target: string;
  /** New scene body (≤1500 chars per upstream cap). */
  content: string;
  /** Optional heat increment. Defaults to "+1" per upstream. */
  heatDelta: number;
}

export interface SceneMergeAction {
  kind: "merge";
  /** Source scene filenames that will be deleted via `[DELETED]` marker. */
  sources: string[];
  /** New merged scene filename (must pass filename rules). */
  target: string;
  /** New merged body (≤1500 chars). */
  content: string;
  heatDelta: number;
}

export interface SceneCreateAction {
  kind: "create";
  /** New scene filename (must pass filename rules + ≤1500 chars body). */
  target: string;
  content: string;
  heatDelta: number;
}

export type SceneAction = SceneUpdateAction | SceneMergeAction | SceneCreateAction;

/** Filename rule (mirrors upstream `📛 文件命名规范`):
 *   - allowed: letters, digits, CJK, `-`, `_`, `.`
 *   - must end with `.md` (lowercase)
 *   - forbidden: spaces, full-width spaces, quotes, brackets, slashes,
 *     colons, semicolons, question marks, exclamation marks, asterisks,
 *     pipes, other punctuation
 */
const FILENAME_DISALLOWED = /[\s'"(){}[\]/\\:;?!*|,]/;

/** Truncate to N codepoints (not UTF-16 code units). */
function truncateToCodepoints(text: string, max: number): string {
  const cps = Array.from(text);
  if (cps.length <= max) return text;
  return cps.slice(0, max).join("");
}

export function isValidSceneFilename(name: string): boolean {
  if (!name) return false;
  if (!name.toLowerCase().endsWith(".md")) return false;
  if (FILENAME_DISALLOWED.test(name)) return false;
  return true;
}

/** Default per-scene body cap (chars, codepoint-based). Mirrors upstream "1500 字符内". */
export const SCENE_BODY_MAX_CHARS = 1500;

/** Out-of-band persona-update request recovered from the LLM text output. */
export interface PersonaUpdateRequest {
  reason: string;
}

interface RawSceneAction {
  action?: string;
  target?: string;
  sources?: string[];
  content?: string;
  heat_delta?: number | string;
}

export interface SceneActionParseResult {
  actions: SceneAction[];
  /** Out-of-band persona-update request recovered from the LLM text. */
  personaUpdateRequest?: PersonaUpdateRequest;
}

/**
 * Heuristically recover a persona-update request from the LLM text output.
 *
 * Looks for the markers and reads the `reason:` line inside the block.
 */
export function recoverPersonaUpdateRequest(rawText: string): PersonaUpdateRequest | undefined {
  if (!rawText) return undefined;
  const openIdx = rawText.indexOf(PERSONA_UPDATE_REQUEST_OPEN);
  if (openIdx < 0) return undefined;
  const closeIdx = rawText.indexOf(PERSONA_UPDATE_REQUEST_CLOSE, openIdx);
  if (closeIdx < 0) return undefined;
  const inner = rawText.slice(openIdx + PERSONA_UPDATE_REQUEST_OPEN.length, closeIdx).trim();
  const reasonMatch = inner.match(/reason\s*:\s*(.+)$/im);
  return { reason: reasonMatch ? reasonMatch[1].trim() : inner };
}

/**
 * Coerce heat_delta into an integer. Default is 1 (mirrors upstream "heat +1").
 */
function coerceHeat(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.max(0, Math.round(n));
  }
  return 1;
}

/**
 * Parse the L2 scene-extraction JSON response into a list of structured
 * actions, in `UPDATE > MERGE > CREATE` priority order.
 *
 * - `mmd` is recovered from ```mermaid``` fences if a `content` field looks
 *   like raw mermaid.
 * - Invalid filenames are dropped (caller can decide to re-normalize).
 * - Oversized bodies are truncated to `SCENE_BODY_MAX_CHARS`.
 * - The JSON shape is intentionally permissive: any of `target`/`sources`/
 *   `content` may be missing — we drop entries that lack the required
 *   minimum fields for their kind.
 */
export function parseSceneExtractionResponse(
  rawJson: string,
  rawText?: string
): SceneActionParseResult {
  const parsed = extractJson<RawSceneAction[]>(rawJson);
  const raw: RawSceneAction[] = Array.isArray(parsed) ? parsed : [];

  const actions: SceneAction[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const action = typeof item.action === "string" ? item.action.toLowerCase() : "";

    let content = typeof item.content === "string" ? item.content : "";
    const fromMermaid = extractMermaidFromFence(content);
    if (fromMermaid) content = fromMermaid;
    if (!content) continue;

    content = truncateToCodepoints(content, SCENE_BODY_MAX_CHARS);
    const heatDelta = coerceHeat(item.heat_delta);

    if (action === "update" || action === "edit" || action === "rewrite") {
      const target = typeof item.target === "string" ? item.target : "";
      if (!isValidSceneFilename(target)) continue;
      actions.push({ kind: "update", target, content, heatDelta });
      continue;
    }

    if (action === "merge") {
      const target = typeof item.target === "string" ? item.target : "";
      const sources = Array.isArray(item.sources)
        ? item.sources.filter((s): s is string => typeof s === "string")
        : [];
      if (!isValidSceneFilename(target)) continue;
      if (sources.length === 0) continue;
      actions.push({ kind: "merge", target, sources, content, heatDelta });
      continue;
    }

    if (action === "create") {
      const target = typeof item.target === "string" ? item.target : "";
      if (!isValidSceneFilename(target)) continue;
      actions.push({ kind: "create", target, content, heatDelta });
      continue;
    }

    // unknown action — drop
  }

  actions.sort((a, b) => SCENE_ACTION_PRIORITY[a.kind] - SCENE_ACTION_PRIORITY[b.kind]);

  const personaUpdateRequest = rawText ? recoverPersonaUpdateRequest(rawText) : undefined;

  return { actions, ...(personaUpdateRequest ? { personaUpdateRequest } : {}) };
}
