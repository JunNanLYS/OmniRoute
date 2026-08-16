/**
 * Final-turn gateway call: the fixture's history plus `finalUser` go through
 * the REAL OmniRoute gateway (non-stream), producing the final assistant
 * message and the correlation id echoed by `X-Correlation-Id`.
 *
 * The history must be included: without it the model cannot see the context
 * the finalUser refers to, so it always answers with a confused
 * "please provide the content" reply — which then lands in L0 and pollutes
 * L1-L3 with harness-induced "misunderstanding" memories (the judge flags
 * them as hallucinations). L0 capture is unaffected: it records only the
 * last visible user and assistant text of the request.
 */
import { httpJson } from "./http.ts";

export interface GatewayTurnResult {
  content: string;
  model: string;
  correlationId: string;
}

export async function sendFinalUserTurn(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  sessionId: string;
  content: string;
  /** Fixture history rendered as prior chat messages before the final turn. */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<GatewayTurnResult> {
  const response = await httpJson<{
    model?: string;
    choices?: Array<{ message?: { content?: string } }>;
    error?: unknown;
  }>(`${options.baseUrl}/v1/chat/completions`, {
    method: "POST",
    bearer: options.apiKey,
    headers: { "x-omniroute-session-id": options.sessionId },
    body: JSON.stringify({
      model: options.model,
      stream: false,
      messages: [...(options.history ?? []), { role: "user", content: options.content }],
    }),
  });

  const content = response.body.choices?.[0]?.message?.content;
  if (!response.ok || typeof content !== "string" || content.length === 0) {
    throw new Error(
      `gateway call failed: HTTP ${response.status} ${JSON.stringify(response.body).slice(0, 400)}`
    );
  }
  const correlationId = response.headers.get("x-correlation-id") ?? "";
  return { content, model: response.body.model ?? options.model, correlationId };
}
