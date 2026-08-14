import { isNoMemoryRequested } from "@omniroute/open-sse/handlers/chatCore/headers.ts";
import { resolveRequestAutoControls } from "@omniroute/open-sse/services/autoCombo/requestControls.ts";
import { resolveComboConfig } from "@omniroute/open-sse/services/comboConfig.ts";

import { wrapFinalComboResponseForL0Capture } from "@/memory/integration/finalComboCapture";
import { resolveMemoryPipelineSettings } from "@/memory/integration/settings";

import { withCorrelationId, withSessionHeader } from "./chatHelpers";

export function resolveComboRelayOptions(
  combo: Parameters<typeof resolveComboConfig>[0] & { strategy?: string },
  settings: Parameters<typeof resolveComboConfig>[1],
  headers: Parameters<typeof resolveRequestAutoControls>[0],
  sessionId: string,
  bypassProviderQuotaPolicy: boolean
) {
  const relayConfig =
    combo.strategy === "context-relay" ? resolveComboConfig(combo, settings) : null;
  const perRequestAutoControls = resolveRequestAutoControls(headers);
  if (
    combo.strategy !== "context-relay" &&
    !bypassProviderQuotaPolicy &&
    Object.keys(perRequestAutoControls).length === 0
  ) {
    return undefined;
  }

  return {
    ...(combo.strategy === "context-relay" ? { sessionId, config: relayConfig } : {}),
    ...(bypassProviderQuotaPolicy ? { bypassProviderQuotaPolicy: true } : {}),
    ...perRequestAutoControls,
  };
}

interface ComboFinalizerInput {
  requestHeaders: Headers | Record<string, unknown> | null | undefined;
  apiKeyId: unknown;
  sessionId: string;
  correlationId: string | null;
  requestBody: Record<string, unknown>;
  preferredFormat: string;
  fallbackModel: string;
  log?: { debug?: (...args: unknown[]) => void } | null;
}

export function createComboFinalizer(input: ComboFinalizerInput) {
  return async (response: Response): Promise<Response> => {
    const taggedResponse = withCorrelationId(
      withSessionHeader(response, input.sessionId),
      input.correlationId
    );
    const ownerId =
      isNoMemoryRequested(input.requestHeaders) || typeof input.apiKeyId !== "string"
        ? null
        : input.apiKeyId;
    if (!ownerId || !taggedResponse.ok) return taggedResponse;

    const settings = await resolveMemoryPipelineSettings(ownerId);
    return wrapFinalComboResponseForL0Capture({
      response: taggedResponse,
      ownerId,
      captureEnabled: settings.captureEnabled,
      sessionId: input.sessionId,
      correlationId: input.correlationId,
      comboExecutionKey: input.correlationId,
      requestBody: input.requestBody,
      preferredFormat: input.preferredFormat,
      fallbackModel: input.fallbackModel,
      log: input.log,
    });
  };
}
