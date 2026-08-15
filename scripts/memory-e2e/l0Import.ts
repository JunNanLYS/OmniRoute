/**
 * Canonical L0 history import through the real API. Only `role` + `content`
 * cross the wire for the message body; idempotency keys are deterministic so
 * re-imports are idempotent. Per design-doc, the importer generates monotonic
 * timestamps in array order: the store's own `recorded_at` is second-granular
 * (`datetime('now')`), which cannot disambiguate same-second turns — the
 * harness's explicit millisecond timestamps make chronological order
 * deterministic.
 */
import { httpJson } from "./http.ts";
import type { FixtureMessage } from "./types.ts";

export async function importFixtureHistory(options: {
  baseUrl: string;
  apiKey: string;
  sessionId: string;
  history: FixtureMessage[];
  /** Epoch ms of the first imported turn; each subsequent turn is +1000 ms. */
  timestampBase: number;
}): Promise<string[]> {
  const items = options.history.map((message, index) => ({
    idempotencyKey: `e2e-${options.sessionId}-${index}`,
    role: message.role,
    content: message.content,
    timestamp: new Date(options.timestampBase + index * 1_000).toISOString(),
  }));
  const response = await httpJson<{ importedIds?: string[] }>(`${options.baseUrl}/api/memory/l0`, {
    method: "POST",
    bearer: options.apiKey,
    body: JSON.stringify({ sessionId: options.sessionId, items }),
  });
  if (!response.ok || !Array.isArray(response.body.importedIds)) {
    throw new Error(
      `l0 import failed: HTTP ${response.status} ${JSON.stringify(response.body).slice(0, 400)}`
    );
  }
  if (response.body.importedIds.length !== items.length) {
    throw new Error(
      `l0 import expected ${items.length} ids, got ${response.body.importedIds.length}`
    );
  }
  return response.body.importedIds;
}
