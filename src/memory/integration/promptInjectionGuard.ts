/**
 * Lightweight prompt-injection guard for the injection transformer.
 *
 * The transformer imports `detector` and calls it (optional); a no-op default
 * is exported here so the pipeline compiles without the heavyweight
 * guardrail bundle. The real guardrail (`src/lib/guardrails/promptInjection.ts`)
 * is not pulled in here to avoid a hot-path dependency cycle.
 */

export function detector(_message: unknown): boolean {
  // No-op default — the transformer handles basic drop via looksLikePromptInjection.
  return false;
}
