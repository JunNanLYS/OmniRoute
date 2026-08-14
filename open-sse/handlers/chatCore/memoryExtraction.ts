/**
 * Pipeline-owned memory text extraction.
 *
 * Hard cutover: the 64KB cap on memory extraction text has been REMOVED. L0
 * stores the FULL text (no length cap). The local helpers below remain
 * unchanged in shape so existing callers keep working — they now return
 * whatever is visible, with no cap.
 *
 * The new L0 capture module (`src/memory/integration/l0Capture.ts`) is the
 * preferred entry point. The legacy `extractFacts` path is removed from the
 * pipeline; the functions below stay for tests and for diagnostic callers.
 */

import { logger } from "../../../open-sse/utils/logger.ts";

const log = logger("MEMORY_EXTRACTION_PIPELINE");

/**
 * Extract the last user-visible text from a response (OpenAI / Anthropic /
 * Responses API). Full text — no cap.
 */
export function extractMemoryTextFromResponse(
  response: Record<string, unknown> | null | undefined
): string {
  if (!response || typeof response !== "object") return "";

  const openAIText = (response as { choices?: unknown[] }).choices;
  if (Array.isArray(openAIText) && openAIText[0]) {
    const first = openAIText[0] as Record<string, unknown>;
    const message = first.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      const text = (content as Record<string, unknown>[])
        .filter((p) => p?.type === "text" && typeof p?.text === "string")
        .map((p) => String((p as { text: unknown }).text).trim())
        .filter(Boolean)
        .join("\n");
      if (text) return text;
    }
  }

  if (Array.isArray((response as { content?: unknown }).content)) {
    const contentText = ((response as { content: unknown[] }).content as Record<string, unknown>[])
      .filter(
        (part) => part?.type === "text" && typeof (part as { text?: unknown }).text === "string"
      )
      .map((part) => String((part as { text: unknown }).text).trim())
      .filter(Boolean)
      .join("\n");
    if (contentText) return contentText;
  }

  if (typeof (response as { output_text?: unknown }).output_text === "string") {
    return String((response as { output_text: string }).output_text).trim();
  }

  return "";
}

/**
 * Extract the last user-visible text from a request body. Full text — no cap.
 * Returns "" if no user message is found.
 */
export function extractMemoryTextFromRequestBody(
  body: Record<string, unknown> | null | undefined
): string {
  if (!body || typeof body !== "object") return "";

  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (messages && messages.length > 0) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i] as Record<string, unknown>;
      if (msg?.role !== "user") continue;
      if (typeof msg.content === "string" && msg.content.trim().length > 0) {
        return msg.content.trim();
      }
      if (Array.isArray(msg.content)) {
        const text = (msg.content as Record<string, unknown>[])
          .map((part) => {
            if (typeof part?.text === "string") return part.text.trim();
            if (part?.type === "input_text" && typeof part?.text === "string")
              return part.text.trim();
            return "";
          })
          .filter(Boolean)
          .join("\n")
          .trim();
        if (text) return text;
      }
    }
  }

  const input = Array.isArray(body.input) ? body.input : null;
  if (input && input.length > 0) {
    for (let i = input.length - 1; i >= 0; i -= 1) {
      const item = input[i] as Record<string, unknown>;
      const role = typeof item?.role === "string" ? item.role.trim().toLowerCase() : "";
      const itemType = typeof item?.type === "string" ? item.type.trim().toLowerCase() : "";
      if (role && role !== "user") continue;
      if (itemType && itemType !== "message") continue;
      if (typeof item?.content === "string" && item.content.trim()) {
        return item.content.trim();
      }
      if (Array.isArray(item?.content)) {
        const text = (item.content as Record<string, unknown>[])
          .map((part) => {
            if (typeof part?.text === "string") return part.text.trim();
            if (part?.type === "input_text" && typeof part?.text === "string")
              return part.text.trim();
            return "";
          })
          .filter(Boolean)
          .join("\n")
          .trim();
        if (text) return text;
      }
    }
  }

  return "";
}

/**
 * Resolve the memory owner id from the API key info. Returns null when the
 * id is missing or invalid.
 */
export function resolveMemoryOwnerId(apiKeyInfo: Record<string, unknown> | null): string | null {
  const rawId = apiKeyInfo?.id;
  if (typeof rawId === "string" && rawId.trim().length > 0) {
    return rawId;
  }
  return null;
}

export const _pipelineLog = log;
