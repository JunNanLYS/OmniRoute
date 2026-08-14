import { parseNonStreamingSSEPayload } from "../../../open-sse/handlers/chatCore/nonStreamingSse.ts";
import { OMNIROUTE_RESPONSE_HEADERS } from "@/shared/constants/headers";
import { scheduleProductionL0Capture } from "./runtime.ts";

interface FinalComboCaptureInput {
  response: Response;
  ownerId: string;
  captureEnabled: boolean;
  sessionId: string;
  correlationId: string | null;
  comboExecutionKey: string | null;
  requestBody: Record<string, unknown>;
  preferredFormat: string;
  fallbackModel: string;
  log?: { debug?: (...args: unknown[]) => void } | null;
}

function parseFinalSnapshot(
  rawBody: string,
  contentType: string,
  preferredFormat: string,
  fallbackModel: string
): Record<string, unknown> | null {
  const trimmed = rawBody.trim();
  if (!trimmed) return null;

  if (
    contentType.toLowerCase().includes("text/event-stream") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("event:")
  ) {
    return parseNonStreamingSSEPayload(rawBody, preferredFormat, fallbackModel)?.body ?? null;
  }

  try {
    const parsed: unknown = JSON.parse(rawBody);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function wrapFinalComboResponseForL0Capture(input: FinalComboCaptureInput): Response {
  if (!input.captureEnabled || !input.response.ok || !input.response.body) {
    return input.response;
  }

  const contentType = input.response.headers.get("content-type") || "";
  const provider = input.response.headers.get(OMNIROUTE_RESPONSE_HEADERS.provider);
  const model = input.response.headers.get(OMNIROUTE_RESPONSE_HEADERS.model) || input.fallbackModel;
  const decoder = new TextDecoder();
  const decodedChunks: string[] = [];

  const captureTransform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      decodedChunks.push(decoder.decode(chunk, { stream: true }));
      controller.enqueue(chunk);
    },
    flush() {
      decodedChunks.push(decoder.decode());
      try {
        const responseBody = parseFinalSnapshot(
          decodedChunks.join(""),
          contentType,
          input.preferredFormat,
          input.fallbackModel
        );
        if (!responseBody) return;

        scheduleProductionL0Capture({
          ownerId: input.ownerId,
          captureEnabled: input.captureEnabled,
          isCombo: true,
          isFinalComboResult: true,
          comboStepId: null,
          sessionId: input.sessionId,
          correlationId: input.correlationId,
          comboExecutionKey: input.comboExecutionKey,
          requestBody: input.requestBody,
          responseBody,
          source: "combo",
          provider,
          model,
          log: input.log,
        });
      } catch (error) {
        input.log?.debug?.(
          "MEMORY",
          `Final combo L0 capture skipped: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  });

  return new Response(input.response.body.pipeThrough(captureTransform), {
    status: input.response.status,
    statusText: input.response.statusText,
    headers: input.response.headers,
  });
}
