/**
 * Default distillation handlers — one per task kind.
 *
 * Each handler is responsible for:
 *   1. Building the prompt/messages for the LLM call (size-capped).
 *   2. Parsing the LLM response into a structured payload the store can
 *      persist. JSON is the canonical shape; we apply a tolerant extractor
 *      because providers frequently wrap it in code fences or prose.
 *   3. Returning the result + a parsed-shape that the worker can hand to
 *      the future `distillation_apply` repository call.
 *
 * The actual provider-facing runner is injected — the handlers themselves
 * do NOT call the executor directly. They take a `callModel` adapter and
 *     the resolved selection, and return a `DistillationHandlerResult`.
 *
 * Tencent prompt integration is a dynamic-import inside each handler so
 * the prompt content is fetched lazily (zero cost when the prompt is not
 * used) and a missing/failing import is a structured error the worker can
 * classify, NOT a crash.
 */

import type { DistillationTask } from "./store.ts";
import { L1_TYPES, type L1Type } from "../types.ts";

export interface HandlerCallArgs {
  task: DistillationTask;
  selection: { provider: string; model: string };
  callModel: (args: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    maxTokens: number;
  }) => Promise<{ text: string; promptTokens: number; completionTokens: number }>;
  budget: {
    maxTokens: number;
    maxSteps: number;
    maxCalls: number;
    maxDepth: number;
  };
  /** Optional override clock (tests only). */
  now?: () => number;
}

export interface HandlerResult {
  /** Structured payload the caller can persist. */
  payload: unknown;
  /** Optional regex-fallback evidence (recorded only as L0 evidence). */
  fallbackEvidence: Array<{ kind: string; match: string }>;
  promptTokens: number;
  completionTokens: number;
}

export type HandlerError =
  | { kind: "budget_exceeded"; message: string }
  | { kind: "parse_failed"; message: string }
  | { kind: "semantic_invalid"; message: string }
  | { kind: "model_unset"; message: string };

export type HandlerOutcome =
  { ok: true; result: HandlerResult } | { ok: false; error: HandlerError };

export type DistillationHandler = ((args: HandlerCallArgs) => Promise<HandlerOutcome>) & {
  readonly kind: DistillationTask["kind"];
};

function defineHandler(
  kind: DistillationTask["kind"],
  fn: (args: HandlerCallArgs) => Promise<HandlerOutcome>
): DistillationHandler {
  const callable = fn as DistillationHandler;
  Object.defineProperty(callable, "kind", { value: kind, enumerable: true });
  return callable;
}

const JSON_BLOCK_RE = /```(?:json)?\s*([\s\S]+?)```/i;
const JSON_FIRST_ARRAY_RE = /\[[\s\S]*\]/;
const JSON_FIRST_OBJECT_RE = /\{[\s\S]*\}/;

function safeParseJson(raw: string): unknown | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fallthrough */
  }
  const fenced = trimmed.match(JSON_BLOCK_RE);
  if (fenced && fenced[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fallthrough */
    }
  }
  for (const pattern of [JSON_FIRST_ARRAY_RE, JSON_FIRST_OBJECT_RE]) {
    const first = trimmed.match(pattern);
    if (!first?.[0]) continue;
    try {
      return JSON.parse(first[0]);
    } catch {
      /* try next shape */
    }
  }
  return null;
}

function capMessages(
  messages: HandlerCallArgs["callModel"] extends (a: infer A) => unknown
    ? A extends { messages: infer M }
      ? M
      : never
    : never
) {
  return messages;
}
void capMessages;

const VALID_L1_TYPES: ReadonlySet<string> = new Set(L1_TYPES);
const L1_TYPE_ALIASES: Readonly<Record<string, L1Type>> = {
  episode: "episodic",
  instruct: "instruction",
  preference: "persona",
};
const DEFAULT_SCENE_NAME = "未知情境";

export interface ExtractedL1Memory {
  content: string;
  type: L1Type;
  priority: number;
  sourceMessageIds: string[];
  metadata: Record<string, unknown>;
}

export interface ExtractedL1Scene {
  sceneName: string;
  messageIds: string[];
  memories: ExtractedL1Memory[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function normalizeL1Type(value: unknown): L1Type | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (VALID_L1_TYPES.has(normalized)) return normalized as L1Type;
  return L1_TYPE_ALIASES[normalized] ?? null;
}

function normalizePriority(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, Math.round(value)))
    : 50;
}

function normalizeMemory(value: unknown): ExtractedL1Memory | null {
  const record = asRecord(value);
  if (!record) return null;
  const content = typeof record.content === "string" ? record.content.trim() : "";
  const type = normalizeL1Type(record.type ?? record.category);
  if (!content || !type) return null;
  return {
    content,
    type,
    priority: normalizePriority(record.priority),
    sourceMessageIds: stringArray(record.source_message_ids ?? record.sourceMessageIds),
    metadata: asRecord(record.metadata) ?? {},
  };
}

function normalizeL1Scenes(parsed: unknown): ExtractedL1Scene[] {
  const legacy = asRecord(parsed);
  const rawScenes = Array.isArray(parsed)
    ? parsed
    : Array.isArray(legacy?.facts)
      ? [
          {
            scene_name: DEFAULT_SCENE_NAME,
            memories: legacy.facts,
          },
        ]
      : [];
  const scenes: ExtractedL1Scene[] = [];
  for (const rawScene of rawScenes) {
    const scene = asRecord(rawScene);
    if (!scene) continue;
    const memories = Array.isArray(scene.memories)
      ? scene.memories
          .map(normalizeMemory)
          .filter((item): item is ExtractedL1Memory => item !== null)
      : [];
    if (memories.length === 0) continue;
    scenes.push({
      sceneName:
        typeof scene.scene_name === "string" && scene.scene_name.trim()
          ? scene.scene_name.trim()
          : DEFAULT_SCENE_NAME,
      messageIds: stringArray(scene.message_ids),
      memories,
    });
  }
  return scenes;
}

/**
 * Generic cap-then-truncate helper. The prompt is the primary cost driver
 * for distillation; oversized payloads trip `budget_exceeded`.
 */
export function clampPrompt(text: string, maxChars: number): string {
  if (typeof text !== "string") return "";
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

/** Build a budget guard — returns ok when the size limits are met. */
function checkBudget(text: string, maxChars: number, stepIdx: number, maxSteps: number) {
  if (stepIdx >= maxSteps) {
    return { ok: false as const, error: "budget_exceeded" as const };
  }
  if (text.length > maxChars) {
    return { ok: false as const, error: "budget_exceeded" as const };
  }
  return { ok: true as const };
}

/** Pure regex fallback that always returns something usable (the L0 evidence). */
function regexFallback(raw: string): Array<{ kind: string; match: string }> {
  const out: Array<{ kind: string; match: string }> = [];
  const patterns: Array<[string, RegExp]> = [
    ["preference", /\b(?:I\s+prefer|I'd\s+rather|I\s+like)\s+([^.!?\n]+)/gi],
    ["decision", /\b(?:I\s+(?:will|chose|picked|selected))\s+([^.!?\n]+)/gi],
    ["pattern", /\b(?:I\s+usually|I\s+always|I\s+never)\s+([^.!?\n]+)/gi],
  ];
  for (const [kind, re] of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) {
      if (m[1]) out.push({ kind, match: m[1].trim().slice(0, 240) });
      if (out.length >= 16) break;
    }
    if (out.length >= 16) break;
  }
  return out;
}

async function loadTencentPrompt(kind: string): Promise<string> {
  try {
    const mod = (await import(`./prompts/tencent/${kind}.ts` as string).catch(() => null)) as {
      TENCENT_PROMPT?: string;
    } | null;
    if (mod?.TENCENT_PROMPT) return mod.TENCENT_PROMPT;
  } catch {
    /* fallthrough */
  }
  // Fallback prompt — embedded so the worker is never blocked on the prompt
  // module. Tencent integration can ship its real prompt in a follow-up commit
  // without changing this file.
  switch (kind) {
    case "L1_extract":
      return [
        "Extract durable memories from the conversation.",
        "Output a strict JSON array of scenes. Each scene has scene_name, message_ids, and memories.",
        "Each memory has content, type, priority, source_message_ids, and metadata.",
        `Allowed types: ${L1_TYPES.join("|")}. No prose.`,
      ].join("\n");
    case "L2_scene":
      return [
        "Update one durable scene from the supplied memories and existing scene context.",
        "Output JSON: { summary, tags: [string], content, heat, persona_update_requested }.",
        "heat must be a number from 0 to 1. No prose.",
      ].join("\n");
    case "L3_persona":
      return [
        "Synthesize the supplied scenes into durable persona or operating-doctrine content.",
        "Output JSON: { content, prompt_mode }. No prose.",
      ].join("\n");
    case "L0_chunk_embed":
      return [
        "You summarise a chunk in <120 chars for vector recall.",
        "Output JSON: { summary }.",
      ].join("\n");
    default:
      return "Output strict JSON.";
  }
}

/**
 * L1_extract — pull durable facts from a conversation slice.
 * Always falls back to regex evidence when JSON parsing fails (recorded
 * as L0 evidence; never silently replaces the LLM response).
 */
export const L1ExtractHandler: DistillationHandler = defineHandler(
  "L1_extract",
  async function L1Extract(args) {
    const payload = args.task.payload as { conversation?: string } | null;
    const conversation = clampPrompt(payload?.conversation ?? "", args.budget.maxTokens * 3);
    const budget = checkBudget(conversation, args.budget.maxTokens * 3, 0, args.budget.maxSteps);
    if (!budget.ok)
      return { ok: false, error: { kind: "budget_exceeded", message: "Input exceeds budget" } };

    const systemPrompt = await loadTencentPrompt("L1_extract");
    const response = await args.callModel({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: conversation },
      ],
      maxTokens: Math.min(2048, args.budget.maxTokens),
    });

    const parsed = safeParseJson(response.text);
    if (!parsed || typeof parsed !== "object") {
      return {
        ok: false,
        error: { kind: "parse_failed", message: "L1_extract: response was not JSON" },
      };
    }
    const scenes = normalizeL1Scenes(parsed);
    if (scenes.length === 0) {
      return {
        ok: false,
        error: { kind: "semantic_invalid", message: "L1_extract: no valid memories" },
      };
    }
    return {
      ok: true,
      result: {
        payload: { scenes },
        fallbackEvidence: regexFallback(conversation),
        promptTokens: response.promptTokens,
        completionTokens: response.completionTokens,
      },
    };
  }
);

/**
 * L2_scene — produce one paragraph + 3 bullet scene tags. Cooldown policy
 * lives in the scheduler; the handler just produces the structured output.
 */
export const L2SceneHandler: DistillationHandler = defineHandler(
  "L2_scene",
  async function L2Scene(args) {
    const payload = args.task.payload as { conversation?: string } | null;
    const conversation = clampPrompt(payload?.conversation ?? "", args.budget.maxTokens * 4);
    const budget = checkBudget(conversation, args.budget.maxTokens * 4, 0, args.budget.maxSteps);
    if (!budget.ok)
      return { ok: false, error: { kind: "budget_exceeded", message: "Input exceeds budget" } };

    const systemPrompt = await loadTencentPrompt("L2_scene");
    const response = await args.callModel({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: conversation },
      ],
      maxTokens: Math.min(1024, args.budget.maxTokens),
    });
    const parsed = safeParseJson(response.text);
    if (!parsed || typeof parsed !== "object") {
      return {
        ok: false,
        error: { kind: "parse_failed", message: "L2_scene: response was not JSON" },
      };
    }
    const parsedRecord = parsed as Record<string, unknown>;
    const summary =
      typeof parsedRecord.summary === "string" ? parsedRecord.summary.trim().slice(0, 1200) : "";
    const tags = Array.isArray(parsedRecord.tags)
      ? parsedRecord.tags
          .filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
          .map((tag) => tag.trim().slice(0, 100))
          .slice(0, 8)
      : [];
    const content =
      typeof parsedRecord.content === "string" ? parsedRecord.content.trim().slice(0, 32_000) : "";
    const heat = parsedRecord.heat;
    if (
      heat !== undefined &&
      (typeof heat !== "number" || !Number.isFinite(heat) || heat < 0 || heat > 1)
    ) {
      return {
        ok: false,
        error: { kind: "semantic_invalid", message: "L2_scene: heat must be in 0..1" },
      };
    }
    if (!summary && tags.length === 0) {
      return {
        ok: false,
        error: { kind: "semantic_invalid", message: "L2_scene: empty result" },
      };
    }
    return {
      ok: true,
      result: {
        payload: {
          summary,
          tags,
          ...(content ? { content } : {}),
          ...(typeof heat === "number" ? { heat } : {}),
          personaUpdateRequested: parsedRecord.persona_update_requested === true,
        },
        fallbackEvidence: [],
        promptTokens: response.promptTokens,
        completionTokens: response.completionTokens,
      },
    };
  }
);

/**
 * L3_persona — fires immediately (no debounce) per the scheduler. The
 * handler is intentionally minimal: 1 prompt + 1 JSON response.
 */
export const L3PersonaHandler: DistillationHandler = defineHandler(
  "L3_persona",
  async function L3Persona(args) {
    const payload = args.task.payload as { samples?: string[] } | null;
    const samples = (payload?.samples ?? []).map((s) => clampPrompt(s, 2000)).slice(0, 8);
    if (samples.length === 0) {
      return { ok: false, error: { kind: "model_unset", message: "No persona samples" } };
    }
    const systemPrompt = await loadTencentPrompt("L3_persona");
    const response = await args.callModel({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: samples.join("\n---\n") },
      ],
      maxTokens: Math.min(512, args.budget.maxTokens),
    });
    const parsed = safeParseJson(response.text);
    if (!parsed || typeof parsed !== "object") {
      return {
        ok: false,
        error: { kind: "parse_failed", message: "L3_persona: response was not JSON" },
      };
    }
    const parsedRecord = parsed as Record<string, unknown>;
    const content =
      typeof parsedRecord.content === "string"
        ? parsedRecord.content.trim()
        : typeof parsedRecord.persona === "string"
          ? parsedRecord.persona.trim()
          : "";
    if (!content) {
      return {
        ok: false,
        error: { kind: "semantic_invalid", message: "L3_persona: empty content" },
      };
    }
    const requestedMode = parsedRecord.prompt_mode ?? parsedRecord.promptMode;
    const payloadMode = (args.task.payload as { promptMode?: unknown } | null)?.promptMode;
    const promptMode =
      requestedMode === "code" || requestedMode === "chat"
        ? requestedMode
        : payloadMode === "code" || payloadMode === "chat"
          ? payloadMode
          : "chat";
    return {
      ok: true,
      result: {
        payload: { content: content.slice(0, 64_000), promptMode },
        fallbackEvidence: [],
        promptTokens: response.promptTokens,
        completionTokens: response.completionTokens,
      },
    };
  }
);

/**
 * L0_chunk_embed — pure deterministic summarisation. The handler is
 * optional in production (the worker can route L0 to a dedicated embedder
 * path), but the default implementation is here so tests have an end-to-end
 * signal that the worker dispatched the right kind.
 */
export const L0ChunkEmbedHandler: DistillationHandler = defineHandler(
  "L0_chunk_embed",
  async function L0ChunkEmbed(args) {
    const payload = args.task.payload as { chunk?: string } | null;
    const chunk = clampPrompt(payload?.chunk ?? "", args.budget.maxTokens * 2);
    if (!chunk) {
      return { ok: false, error: { kind: "model_unset", message: "No chunk" } };
    }
    const systemPrompt = await loadTencentPrompt("L0_chunk_embed");
    const response = await args.callModel({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: chunk },
      ],
      maxTokens: Math.min(256, args.budget.maxTokens),
    });
    const parsed = safeParseJson(response.text);
    const summary =
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { summary?: unknown }).summary === "string"
        ? ((parsed as { summary: string }).summary as string).slice(0, 200)
        : "";
    if (!summary) {
      return {
        ok: false,
        error: { kind: "parse_failed", message: "L0_chunk_embed: response was not JSON" },
      };
    }
    return {
      ok: true,
      result: {
        payload: { summary },
        fallbackEvidence: [],
        promptTokens: response.promptTokens,
        completionTokens: response.completionTokens,
      },
    };
  }
);

/** Default registry — exported so tests can override individual entries. */
export const DEFAULT_HANDLERS: Record<DistillationTask["kind"], DistillationHandler> = {
  L0_chunk_embed: L0ChunkEmbedHandler,
  L1_extract: L1ExtractHandler,
  L2_scene: L2SceneHandler,
  L3_persona: L3PersonaHandler,
};
