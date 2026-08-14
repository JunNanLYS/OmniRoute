/**
 * L0 capture — the new hot-path persistence layer.
 *
 * Stores the last user + assistant visible text into a raw message store. The
 * storage layer is exposed as an interface (`L0MessageStore`) so the future
 * Tencent snapshot / distillation worker can plug in here without touching the
 * pipeline. A default adapter (`createInMemoryL0Store`) is provided for tests
 * and as a fallback when no real store is registered.
 *
 * Hard cutover from the legacy `extractFacts` path:
 *   - FULL text storage (no 64KB cap on input).
 *   - Preserve user-visible text byte-for-byte in L0. Sanitization belongs to
 *     downstream distillation inputs, never the raw source layer.
 *   - Pure extraction MUST NOT throw — failures fall back to safe defaults.
 *   - Async write is scheduled via setImmediate; failures are logged + skipped
 *     with NO response impact. No retry.
 *   - On successful capture, enqueue a downstream L1 task (interface, no-op by
 *     default in this cutover).
 *   - Two messages are inserted (user + assistant) with stable
 *     idempotency-derived IDs.
 *   - Gate is enforced: no-memory header, internal marker (is_internal),
 *     captureEnabled setting, combo final-target only.
 *   - L0 is NEVER auto-injected back into the prompt.
 */

import { createHash } from "node:crypto";
import { logger } from "../../../open-sse/utils/logger.ts";

const log = logger("MEMORY_L0_CAPTURE");

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export type L0Role = "user" | "assistant";

export interface L0MessageInput {
  role: L0Role;
  /** Visible text only — tools, system, and reasoning are NOT captured. */
  content: string;
}

export interface L0CaptureMetadata {
  /** Pipeline session id (explicit header or skillRequestId fallback). */
  session_key: string;
  /** Stable identifier for the pipeline session. */
  pipelineSessionId: string;
  /** Owner user id = API key id. */
  user_id: string;
  role: L0Role;
  /** Source tag — e.g. "chat", "stream", "combo". */
  source: string;
  /** ISO timestamp set at capture time. */
  timestamp: string;
  /** Request correlation id (when available). */
  correlation_id: string | null;
  /** Combo execution key (when in a combo routing tree). */
  combo_execution_key: string | null;
  /** Internal marker — never capture internal/system-only traffic. */
  is_internal: false;
  /** Provider id (e.g. "openai", "anthropic"). */
  provider: string | null;
  /** Model id. */
  model: string | null;
}

export interface L0MessageRecord {
  /** Stable idempotency-derived ID. */
  id: string;
  ownerId: string;
  sessionId: string;
  role: L0Role;
  content: string;
  metadata: L0CaptureMetadata;
  createdAt: string;
}

export interface L0MessageStore {
  /** Persist a single record. Async failure must be swallowed by the pipeline. */
  insert(record: L0MessageRecord): Promise<void> | void;
  /** Optional: bulk variant for tests. */
  insertMany?(records: L0MessageRecord[]): Promise<void> | void;
}

/** L1 task interface — the distillation pipeline enqueues here. */
export interface L1TaskEnqueuer {
  enqueueL1Task(input: {
    ownerId: string;
    sessionId: string;
    correlationId: string | null;
    capturedAt: string;
    /** The exact records that were committed successfully to L0. */
    records: readonly L0MessageRecord[];
  }): void | Promise<void>;
}

/** Default no-op enqueuer wired in until the worker exists. */
export const noopL1Enqueuer: L1TaskEnqueuer = {
  enqueueL1Task() {
    /* no-op in this cutover */
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// Settings + gate
// ──────────────────────────────────────────────────────────────────────────────

export interface L0CaptureGateInput {
  /** No-memory header was honored -> ownerId is null. */
  ownerId: string | null;
  /** Internal marker — must be false for user-facing capture. */
  isInternal: boolean;
  /** Per-API-key settings. */
  captureEnabled: boolean;
  /** Is the request inside a combo routing tree? */
  isCombo: boolean;
  /** True only at the top-level, client-visible combo response boundary. */
  isFinalComboResult?: boolean;
  /** Stable key per combo execution (nullable). */
  comboExecutionKey: string | null;
  /** Stable id per combo step (nullable). */
  comboStepId: string | null;
}

export interface L0CaptureGateResult {
  /** True when L0 capture should run for this request. */
  shouldCapture: boolean;
  /** Why the gate was rejected (or null when captured). */
  reason: string | null;
}

/**
 * Combo target requests are always rejected by `evaluateL0CaptureGate`. A caller
 * at the top-level response boundary may override that rejection only by passing
 * `isFinalComboResult: true` to `shouldCaptureComboResult`.
 */
export function evaluateL0CaptureGate(input: L0CaptureGateInput): L0CaptureGateResult {
  if (!input.ownerId) {
    return { shouldCapture: false, reason: "no-memory-header-or-no-owner" };
  }
  if (input.isInternal) {
    return { shouldCapture: false, reason: "internal-marker" };
  }
  if (!input.captureEnabled) {
    return { shouldCapture: false, reason: "capture-disabled" };
  }
  if (input.isCombo) {
    return { shouldCapture: false, reason: "combo-subrequest-skipped" };
  }
  return { shouldCapture: true, reason: null };
}

/**
 * Explicit helper for combo final-result detection. Internal target attempts do
 * not pass the marker and remain rejected; only the top-level response wrapper
 * can identify a response as the one returned to the client.
 */
export function shouldCaptureComboResult(input: {
  isCombo: boolean;
  comboExecutionKey: string | null;
  comboStepId: string | null;
  isFinalComboResult?: boolean;
}): boolean {
  if (!input.isCombo) return true;
  void input.comboExecutionKey;
  void input.comboStepId;
  return input.isFinalComboResult === true;
}

// ──────────────────────────────────────────────────────────────────────────────
// Text extraction (pure)
// ──────────────────────────────────────────────────────────────────────────────

const USER_CONTENT_TYPES = new Set(["text", "input_text", "output_text"]);
const NON_USER_INPUT_TYPES = new Set([
  "function_call",
  "function_call_output",
  "tool_call",
  "tool_call_output",
  "reasoning",
  "computer_call",
  "computer_call_output",
  "web_search_call",
  "file_search_call",
]);

/**
 * Read the last visible text from a chat-style `messages` array. NO tools,
 * NO system, NO reasoning — visible text only.
 */
export function extractLastVisibleUserText(
  body: Record<string, unknown> | null | undefined
): string {
  if (!body || typeof body !== "object") return "";
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const item = messages[i] as Record<string, unknown> | undefined;
      if (!item) continue;
      if (item.role !== "user") continue;
      const text = readVisibleText(item.content);
      if (text) return text.trim();
    }
  }
  const input = Array.isArray(body.input) ? body.input : null;
  if (input) {
    for (let i = input.length - 1; i >= 0; i--) {
      const item = input[i] as Record<string, unknown> | undefined;
      if (!item) continue;
      const role = typeof item.role === "string" ? item.role.toLowerCase() : "";
      const itemType = typeof item.type === "string" ? item.type.toLowerCase() : "";
      if (role && role !== "user") continue;
      if (itemType && NON_USER_INPUT_TYPES.has(itemType)) continue;
      const text = readVisibleText(item.content);
      if (text) return text.trim();
    }
  }
  return "";
}

/**
 * Read the last visible text from an assistant response. Supports OpenAI
 * `choices[0].message.content`, Anthropic `content[]` text blocks, and
 * Responses-API `output_text`.
 */
export function extractLastVisibleAssistantText(
  response: Record<string, unknown> | null | undefined
): string {
  if (!response || typeof response !== "object") return "";

  const openAIText = (response as { choices?: unknown[] }).choices;
  if (Array.isArray(openAIText) && openAIText[0]) {
    const first = openAIText[0] as Record<string, unknown>;
    const message = first.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = (content as Record<string, unknown>[])
        .filter((p) => USER_CONTENT_TYPES.has(typeof p?.type === "string" ? p.type : ""))
        .map((p) =>
          typeof p?.text === "string"
            ? p.text
            : typeof p?.input_text === "string"
              ? p.input_text
              : ""
        )
        .filter(Boolean)
        .join("\n");
      if (text) return text;
    }
  }

  const content = (response as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const text = (content as Record<string, unknown>[])
      .filter((p) => p?.type === "text" && typeof p?.text === "string")
      .map((p) => String((p as { text: unknown }).text))
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }

  const outputText = (response as { output_text?: unknown }).output_text;
  if (typeof outputText === "string") return outputText;

  return "";
}

function readVisibleText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const p of content) {
    if (typeof p === "string") {
      parts.push(p);
      continue;
    }
    if (p && typeof p === "object") {
      const pp = p as Record<string, unknown>;
      const ptype = typeof pp.type === "string" ? pp.type : "";
      if (ptype && !USER_CONTENT_TYPES.has(ptype)) continue;
      const t =
        typeof pp.text === "string"
          ? pp.text
          : typeof pp.input_text === "string"
            ? pp.input_text
            : "";
      if (t) parts.push(t);
    }
  }
  return parts.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// Strip code blocks (pure fallback + dynamic helper)
// ──────────────────────────────────────────────────────────────────────────────

const CODE_BLOCK_REGEX = /^```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```\s*$/;

interface StripResult {
  text: string;
  stripped: boolean;
}

/**
 * Pure local fallback. Strips a single outer markdown code fence if present.
 * Does NOT recursively strip multiple fences (the Tencent helper does that),
 * but the local fallback is intentionally narrow (no code inside non-code
 * text is touched).
 */
export function stripCodeBlocksLocal(text: string): string {
  if (typeof text !== "string") return text;
  const trimmed = text.trim();
  const match = trimmed.match(CODE_BLOCK_REGEX);
  if (match) return match[1].trim();
  return text;
}

/**
 * Strip code blocks via a dynamically imported Tencent helper when available,
 * falling back to the pure local helper. The dynamic import is async-loaded
 * on first call and the result is NOT cached here (the helper may do its own
 * caching).
 *
 * Returns the original text on any failure — pure extraction MUST NOT throw.
 */
export async function stripCodeBlocks(text: string): Promise<StripResult> {
  if (typeof text !== "string" || text.length === 0) return { text: text ?? "", stripped: false };
  try {
    const mod = await importTencentStripCodeBlocks().catch(() => null);
    if (mod && typeof mod.stripCodeBlocks === "function") {
      const out = await Promise.resolve(mod.stripCodeBlocks(text));
      if (typeof out === "string") {
        return { text: out, stripped: out !== text };
      }
    }
  } catch (err) {
    log.debug("l0.stripCodeBlocks.dynamic.helperFailed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  const stripped = stripCodeBlocksLocal(text);
  return { text: stripped, stripped: stripped !== text };
}

let _tencentModulePromise: Promise<unknown> | null = null;
async function importTencentStripCodeBlocks(): Promise<{
  stripCodeBlocks: (input: string) => unknown;
} | null> {
  if (_tencentModulePromise === null) {
    _tencentModulePromise = import(
      // tencentDB agent memory snapshot helper — wired dynamically so the
      // export is optional. If the module does not exist (the build target
      // does not ship it), the dynamic import rejects and we fall back.
      // The path is intentionally a constant so tree-shaking does not bundle
      // the optional helper into the chat pipeline.
      "../tencent/text/sanitize.ts"
    ).catch(() => null);
  }
  const mod = await _tencentModulePromise;
  if (mod && typeof mod === "object" && "stripCodeBlocks" in mod) {
    return mod as { stripCodeBlocks: (input: string) => unknown };
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// ID generation
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Build a stable L0 message id from the hash of owner + session + correlation +
 * role + content. Provided idempotency keys win when set.
 *
 * The hash is sha256 truncated to 32 hex chars — short enough to log, long
 * enough to be collision-resistant in practice.
 */
export function buildL0MessageId(input: {
  ownerId: string;
  sessionId: string;
  correlationId: string | null;
  role: L0Role;
  content: string;
  providedIdempotencyKey?: string | null;
}): string {
  if (input.providedIdempotencyKey && typeof input.providedIdempotencyKey === "string") {
    return `l0_${input.providedIdempotencyKey.slice(0, 96)}`;
  }
  const h = createHash("sha256");
  h.update(input.ownerId);
  h.update("\n");
  h.update(input.sessionId);
  h.update("\n");
  h.update(input.correlationId ?? "");
  h.update("\n");
  h.update(input.role);
  h.update("\n");
  h.update(input.content);
  return `l0_${h.digest("hex").slice(0, 32)}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Capture pipeline
// ──────────────────────────────────────────────────────────────────────────────

export interface L0CaptureInputs {
  ownerId: string;
  sessionId: string;
  correlationId: string | null;
  comboExecutionKey: string | null;
  /** User-visible request body (translated). */
  requestBody: Record<string, unknown> | null | undefined;
  /** Final assistant snapshot (status 200 only). */
  responseBody: Record<string, unknown> | null | undefined;
  source: string;
  provider: string | null;
  model: string | null;
}

export interface L0CaptureController {
  /** Storage adapter. */
  store: L0MessageStore;
  /** L1 enqueue adapter. */
  enqueueL1: L1TaskEnqueuer;
  /** Optional logger for human-readable debugging. */
  log?: { debug?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void } | null;
  /** Called after the L0 store accepts every record (success telemetry hook). */
  onSuccess?: () => void;
  /** Called when the L0 store rejects one or more records (failure telemetry hook). */
  onFailure?: (category: "storage_error") => void;
}

/**
 * Pure synchronous orchestration — builds the records, returns them. The caller
 * (the pipeline integration shim) is responsible for scheduling the async write
 * via setImmediate, so the hot path NEVER blocks.
 *
 * Returns an empty array when the gate rejects or no visible text is found.
 */
export function buildL0CaptureRecords(input: L0CaptureInputs): L0MessageRecord[] {
  const userText = extractLastVisibleUserText(input.requestBody);
  const assistantRaw = extractLastVisibleAssistantText(input.responseBody);
  if (!userText && !assistantRaw) return [];

  const records: L0MessageRecord[] = [];
  const timestamp = new Date().toISOString();
  const baseMetadata = {
    session_key: input.sessionId,
    pipelineSessionId: input.sessionId,
    user_id: input.ownerId,
    source: input.source,
    timestamp,
    correlation_id: input.correlationId,
    combo_execution_key: input.comboExecutionKey,
    is_internal: false as const,
    provider: input.provider,
    model: input.model,
  };

  if (userText) {
    records.push({
      id: buildL0MessageId({
        ownerId: input.ownerId,
        sessionId: input.sessionId,
        correlationId: input.correlationId,
        role: "user",
        content: userText,
      }),
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      role: "user",
      content: userText,
      metadata: { ...baseMetadata, role: "user" },
      createdAt: timestamp,
    });
  }

  if (assistantRaw) {
    records.push({
      id: buildL0MessageId({
        ownerId: input.ownerId,
        sessionId: input.sessionId,
        correlationId: input.correlationId,
        role: "assistant",
        content: assistantRaw,
      }),
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      role: "assistant",
      content: assistantRaw,
      metadata: { ...baseMetadata, role: "assistant" },
      createdAt: timestamp,
    });
  }

  return records;
}

/**
 * Schedule a fire-and-forget L0 write. NEVER throws, NEVER awaits upstream.
 * Uses setImmediate so the write runs after the current tick completes.
 *
 * The records are already the canonical raw payload. Sanitization must happen
 * only in a downstream consumer that works on its own copy.
 */
export function scheduleL0Capture(
  records: L0MessageRecord[],
  controller: L0CaptureController
): void {
  if (records.length === 0) return;
  setImmediate(() => {
    void (async () => {
      try {
        if (controller.store.insertMany) {
          await Promise.resolve(controller.store.insertMany(records));
        } else {
          for (const record of records) {
            await Promise.resolve(controller.store.insert(record));
          }
        }
        try {
          controller.onSuccess?.();
        } catch (err) {
          controller.log?.debug?.(
            "l0.telemetry.successHookFailed",
            err instanceof Error ? err.message : String(err)
          );
        }
        try {
          const first = records[0];
          await Promise.resolve(
            controller.enqueueL1.enqueueL1Task({
              ownerId: first.ownerId,
              sessionId: first.sessionId,
              correlationId: first.metadata.correlation_id,
              capturedAt: first.createdAt,
              records,
            })
          );
        } catch (err) {
          controller.log?.debug?.(
            "l0.l1.enqueueFailed",
            err instanceof Error ? err.message : String(err)
          );
        }
      } catch (err) {
        log.debug("l0.capture.failed", {
          err: err instanceof Error ? err.message : String(err),
        });
        controller.log?.debug?.(
          "l0.capture.failed",
          err instanceof Error ? err.message : String(err)
        );
        try {
          controller.onFailure?.("storage_error");
        } catch (hookErr) {
          controller.log?.debug?.(
            "l0.telemetry.failureHookFailed",
            hookErr instanceof Error ? hookErr.message : String(hookErr)
          );
        }
      }
    })();
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Default adapters (in-memory) — for tests and fallback
// ──────────────────────────────────────────────────────────────────────────────

export function createInMemoryL0Store(): L0MessageStore & {
  records: L0MessageRecord[];
} {
  const records: L0MessageRecord[] = [];
  return {
    records,
    insert(record) {
      records.push(record);
    },
    insertMany(many) {
      for (const r of many) records.push(r);
    },
  };
}
