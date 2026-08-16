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
 * Prompt text is kept inline and matched to each handler's canonical output
 * contract. Tencent prompt modules require explicit adapters before they can
 * replace these fallbacks safely.
 */

import type { DistillationTask } from "./store.ts";
import { L1_TYPES, type L1Type } from "../types.ts";

export interface HandlerCallArgs {
  task: DistillationTask;
  selection: { provider: string; model: string };
  callModel: (args: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    maxTokens: number;
  }) => Promise<{
    text: string;
    promptTokens: number;
    completionTokens: number;
    finishReason?: string;
  }>;
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

/**
 * Provider output ceiling for the max_tokens request field. v4-flash accepts
 * up to ~325k output tokens (1M context); operators stay far below via
 * MEMORY_DISTILLATION_MAX_TOKENS, so this only clamps absurd budgets.
 */
const MAX_OUTPUT_TOKENS_CEILING = 325_000;

function clampMaxTokens(budgetMaxTokens: number): number {
  return Math.min(MAX_OUTPUT_TOKENS_CEILING, Math.max(1, Math.floor(budgetMaxTokens)));
}

type ModelCallMessages = Array<{ role: "system" | "user" | "assistant"; content: string }>;

/**
 * Single compliance retry for truncated completions. Reasoning models can
 * burn the entire completion budget on hidden reasoning (finish_reason
 * "length", empty content) before emitting any JSON — measured live on
 * deepseek-v4-flash with identical input succeeding and failing across
 * draws. One redraw at the same budget is cheap insurance and does not
 * touch the run-level no-retry policy (the retry is inside one handler
 * execution, within budget.maxCalls).
 */
async function callModelWithLengthRetry(
  args: HandlerCallArgs,
  messages: ModelCallMessages,
  maxTokens: number
): Promise<Awaited<ReturnType<HandlerCallArgs["callModel"]>>> {
  const first = await args.callModel({ messages, maxTokens });
  if (first.finishReason !== "length") return first;
  return args.callModel({ messages, maxTokens });
}

/** Flattened, length-capped response preview for error messages (DLQ evidence). */
function responsePreview(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 160);
}

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

/**
 * Priority labels emitted by some models instead of numbers ("high", ...).
 * Mapped to the documented bands; anything unrecognized falls back to 50.
 */
const PRIORITY_LABELS: Readonly<Record<string, number>> = {
  critical: 95,
  highest: 95,
  high: 80,
  medium: 60,
  normal: 50,
  low: 30,
  lowest: 15,
};

function normalizePriority(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(100, Math.max(0, Math.round(value)));
  }
  if (typeof value === "string") {
    return PRIORITY_LABELS[value.trim().toLowerCase()] ?? 50;
  }
  return 50;
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
  // Top-level array is canonical; models occasionally wrap the same payload
  // in {scenes: [...]} (or the legacy {facts: [...]}) — all three accepted.
  const rawScenes = Array.isArray(parsed)
    ? parsed
    : Array.isArray(legacy?.facts)
      ? [
          {
            scene_name: DEFAULT_SCENE_NAME,
            memories: legacy.facts,
          },
        ]
      : Array.isArray(legacy?.scenes)
        ? legacy.scenes
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
  // Inline prompts are intentional: the former variable dynamic import pointed to
  // a non-existent path/export and caused Turbopack Module-not-found warnings.
  //
  // The prompt contracts below follow the validated design of the reference
  // MemoryCore system (D:\Project\TencentDB-Agent-Memory\MemoryCore): explicit
  // output-language policy, per-type definitions with priority bands, a
  // durability bar (prefer fewer, better memories), and strict anti-hallucination
  // grounding. The opening phrase of each prompt doubles as the classification
  // marker for the smoke-harness mock upstream (`classifyMockCall`) — keep them
  // stable: "Extract durable memories", "Update one durable scene",
  // "Synthesize the supplied scenes".
  switch (kind) {
    case "L1_extract":
      return [
        "Extract durable memories from the conversation for a long-term agent memory system.",
        "",
        "Language: write scene_name and memory content in the same language as the conversation's user messages; keep JSON keys, type values, and field names in English.",
        "",
        "Durability bar — prefer fewer, better memories:",
        "- Extract only information that stays true outside this conversation: standing preferences, identity, decisions, constraints, project facts, task states, ways of working.",
        '- Drop transient one-off requests ("this time", "this order"), small talk, temporary states (e.g. being sick today), stage metrics (story points, alert counts), and anything the user says not to remember.',
        "- Never record the assistant's own replies or behavior — what the assistant said, did, asked for, or failed to do is not a memory. Only user-side information counts.",
        "- Never invent or infer facts: suggestions and hypotheses are not decisions; only confirmed statements become memories.",
        "- Merge strongly related statements into one complete memory instead of fragments.",
        "",
        `Types (exactly one per memory): ${L1_TYPES.join("|")}.`,
        "- persona: stable user attributes — identity, role, skills, values, habits.",
        "- episodic: objective events or plans — what happened or was decided, with time and place when stated.",
        "- instruction: standing rules the user set for the assistant — format, tone, workflow.",
        "- work_fact: stable project or organization facts — ownership, relations, deadlines, tooling choices.",
        "- work_task: task or project state — goal, owner, status, next step.",
        "- work_method: reusable ways of working — SOPs, principles, constraints, anti-patterns.",
        "- work_artifact: durable artifacts — docs, repos, branches, designs.",
        "",
        "priority: integer 0-100 — 80-100 hard constraints and critical facts, 50-79 normal, below 50 minor (prefer dropping instead).",
        "",
        'Conversation lines are formatted "[message-id] role: content". Use those bracketed ids verbatim for message_ids and source_message_ids.',
        "",
        "Scenes: group the conversation into one or more topics; name each scene concisely by what the user is doing there. Scene names must be unique within the response.",
        "",
        "Output ONLY a valid JSON array — no markdown fences, no prose:",
        '[{"scene_name":"...","message_ids":["..."],"memories":[{"content":"...","type":"persona","priority":80,"source_message_ids":["..."],"metadata":{}}]}]',
        "Return [] when nothing durable exists.",
      ].join("\n");
    case "L2_scene":
      return [
        'Update one durable scene record for a long-term agent memory system. The input lists the memories that belong to this scene as "type: content" lines.',
        "",
        "Language: write summary, content, and tags in the same language as the supplied memories; keep JSON keys in English.",
        "",
        "Field contract:",
        '- summary: a compact, specific digest that preserves the concrete facts — rules, owners, deadlines, choices, and numbers that are constraints. Never write vague meta like "rules were reaffirmed" — name the rules.',
        "- content: optional structured notes (short lines) restating the same facts; no new information.",
        "- tags: up to 8 short topic tags.",
        "- heat: number from 0 to 1 — 0.3-0.5 occasional, around 0.7 active, 0.9 recurring and central.",
        "- persona_update_requested: true only when these memories reveal a stable user trait that belongs in the persona layer.",
        "",
        'Strictly forbidden: inventing events, meetings, decisions, people, numbers, or narratives that are not in the supplied memories; storytelling or fiction; meta-commentary about the input (e.g. "no memories supplied"); contradicting or reinterpreting the supplied facts.',
        "",
        "Output ONLY JSON — no markdown fences, no prose:",
        '{"summary":"...","tags":["..."],"content":"...","heat":0.5,"persona_update_requested":false}',
      ].join("\n");
    case "L3_persona":
      return [
        "Synthesize the supplied scenes into one durable persona / operating-doctrine document for a long-term agent memory system.",
        "",
        "Language: write content in the same language as the supplied scenes; keep JSON keys in English.",
        "",
        "Grounding rules — strict:",
        "- Every statement must be directly supported by the supplied scenes. Anything the scenes do not mention must not appear: no invented details, tools, examples, or generic engineering clichés.",
        "- Cold-start restraint: when the scenes carry little information, a short persona is correct — do not pad.",
        "- Preserve hard constraints and decisions exactly as stated; never soften, flip, or reinterpret them (a rejected option stays rejected; a superseded rule stays superseded).",
        "- Keep the document under 2000 characters. Prefer a few structured sections over prose.",
        "",
        "Output ONLY JSON — no markdown fences, no prose:",
        '{"content":"...","prompt_mode":"chat"}',
      ].join("\n");
    case "L0_chunk_embed":
      return [
        "Summarise a chunk for vector recall in under 120 characters, in the same language as the chunk.",
        'Output ONLY JSON: {"summary":"..."}.',
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
    const messages: ModelCallMessages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: conversation },
    ];
    const response = await callModelWithLengthRetry(
      args,
      messages,
      clampMaxTokens(args.budget.maxTokens)
    );

    const parsed = safeParseJson(response.text);
    if (!parsed || typeof parsed !== "object") {
      return {
        ok: false,
        error: {
          kind: "parse_failed",
          message: `L1_extract: response was not JSON (finish_reason=${
            response.finishReason ?? "unknown"
          }; response="${responsePreview(response.text)}")`,
        },
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
    const messages: ModelCallMessages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: conversation },
    ];
    const response = await callModelWithLengthRetry(
      args,
      messages,
      clampMaxTokens(args.budget.maxTokens)
    );
    const parsed = safeParseJson(response.text);
    if (!parsed || typeof parsed !== "object") {
      return {
        ok: false,
        error: {
          kind: "parse_failed",
          message: `L2_scene: response was not JSON (finish_reason=${
            response.finishReason ?? "unknown"
          }; response="${responsePreview(response.text)}")`,
        },
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
        error: {
          kind: "semantic_invalid",
          message: `L2_scene: heat must be in 0..1 (got ${JSON.stringify(heat)})`,
        },
      };
    }
    // `content` counts as a valid payload: models that pour everything into
    // the content field (leaving summary/tags empty) used to be failed here.
    if (!summary && tags.length === 0 && !content) {
      return {
        ok: false,
        error: {
          kind: "semantic_invalid",
          message: `L2_scene: empty result (finish_reason=${
            response.finishReason ?? "unknown"
          }; response="${responsePreview(response.text)}")`,
        },
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
    const messages: ModelCallMessages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: samples.join("\n---\n") },
    ];
    const response = await callModelWithLengthRetry(
      args,
      messages,
      clampMaxTokens(args.budget.maxTokens)
    );
    const parsed = safeParseJson(response.text);
    if (!parsed || typeof parsed !== "object") {
      return {
        ok: false,
        error: {
          kind: "parse_failed",
          message: `L3_persona: response was not JSON (finish_reason=${
            response.finishReason ?? "unknown"
          }; response="${responsePreview(response.text)}")`,
        },
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
    const messages: ModelCallMessages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: chunk },
    ];
    const response = await callModelWithLengthRetry(
      args,
      messages,
      clampMaxTokens(args.budget.maxTokens)
    );
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
        error: {
          kind: "parse_failed",
          message: `L0_chunk_embed: response was not JSON (finish_reason=${
            response.finishReason ?? "unknown"
          }; response="${responsePreview(response.text)}")`,
        },
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
