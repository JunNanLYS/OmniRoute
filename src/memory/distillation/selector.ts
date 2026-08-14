/**
 * Provider/model selector — the 4-tier chain that decides which provider
 * and model a distillation task should run against.
 *
 * Order (first wins):
 *
 *   1. Per-task hint (`task.providerHint` / `task.modelHint`) — caller has
 *      already locked the choice; the worker MUST honor it without ever
 *      silently switching mid-run.
 *   2. Per-key setting — `scopeKey.settings.distillation.provider/model`.
 *      Looked up via the dynamic `getPerKeyDistillationSettings` (the
 *      repository owner fills this in).
 *   3. Global setting — `settings.distillation.provider/model` (the same
 *      operator-wide knob).
 *   4. `MEMORY_DISTILLATION_MODEL` env override (`prov/model`).
 *   5. First active configured provider × first synced model.
 *
 * If NONE of the above resolves, the worker MUST surface a `model_unset`
 * failure (NOT silently fall back to anything else). The "no silent
 * fallback" rule is critical for reproducibility: a model that no longer
 * works on the operator's account should fail loudly, not keep getting
 * served by a different model the task did not ask for.
 */

import { parseDistillationModelOverride } from "./config.ts";
import type { DistillationTask } from "./store.ts";

export interface SelectorResolution {
  provider: string;
  model: string;
  source: "task_hint" | "per_key" | "global" | "env" | "first_active";
}

export interface PerKeyDistillationSettings {
  provider: string | null;
  model: string | null;
}

export interface GlobalDistillationSettings {
  provider: string | null;
  model: string | null;
}

export interface CatalogSnapshot {
  /** Provider name → models. Caller keeps this stable for the whole worker run. */
  providers: Map<string, readonly string[]>;
  /** Connection metadata used to validate the model is currently usable. */
  isModelUsable(provider: string, model: string): boolean;
}

export interface SelectorDeps {
  resolvePerKeySettings(scope: string): Promise<PerKeyDistillationSettings | null>;
  resolveGlobalSettings(): Promise<GlobalDistillationSettings>;
  loadCatalogSnapshot(): Promise<CatalogSnapshot>;
  env: NodeJS.ProcessEnv;
  /** Optional — the worker keeps this empty in tests; production may
   *  preload a list of trusted loopback tokens. */
  trustedLoopbackTokens?: readonly string[];
}

/**
 * Core selector. No I/O on the common path — the catalog snapshot is the
 * only I/O call, and the caller is expected to memoize it for the worker run.
 */
export async function resolveDistillationSelection(
  task: DistillationTask,
  deps: SelectorDeps
): Promise<SelectorResolution | null> {
  // 1. Per-task hint.
  if (task.providerHint && task.modelHint) {
    return {
      provider: task.providerHint,
      model: task.modelHint,
      source: "task_hint",
    };
  }

  // 2. Per-key setting.
  const perKey = await deps.resolvePerKeySettings(task.scope);
  if (perKey?.provider && perKey?.model) {
    return { provider: perKey.provider, model: perKey.model, source: "per_key" };
  }

  // 3. Global setting.
  const global = await deps.resolveGlobalSettings();
  if (global.provider && global.model) {
    return { provider: global.provider, model: global.model, source: "global" };
  }

  // 4. Env override.
  const envOverride = parseDistillationModelOverride(deps.env.MEMORY_DISTILLATION_MODEL);
  if (envOverride) {
    return { provider: envOverride.provider, model: envOverride.model, source: "env" };
  }

  // 5. First active provider × first synced model.
  const catalog = await deps.loadCatalogSnapshot();
  for (const [provider, models] of catalog.providers) {
    const first = models[0];
    if (first) {
      return { provider, model: first, source: "first_active" };
    }
  }
  return null;
}

/**
 * Build a `USE_CREDENTIALS_INVALID` signal from the selector when the
 * catalog snapshot does not list the resolved model any more (the model
 * was deleted between selection and execution).
 */
export function validateModelStillUsable(
  selection: SelectorResolution,
  catalog: CatalogSnapshot
): { ok: true } | { ok: false; reason: "model_unset" | "model_deleted" } {
  const models = catalog.providers.get(selection.provider);
  if (!models || models.length === 0) {
    return { ok: false, reason: "model_unset" };
  }
  if (!models.includes(selection.model)) {
    return { ok: false, reason: "model_deleted" };
  }
  if (!catalog.isModelUsable(selection.provider, selection.model)) {
    return { ok: false, reason: "model_deleted" };
  }
  return { ok: true };
}
