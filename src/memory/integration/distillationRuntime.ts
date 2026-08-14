import type {
  ExecuteInput,
  ExecutorExecuteResult,
  ProviderCredentials,
} from "@omniroute/open-sse/executors/base.ts";

import {
  makeProductionBreakerHook,
  isWorkerStartAllowed,
  startDistillationWorker,
  type ExecutorBreakerHook,
  type ExecutorDeps,
  type SelectorDeps,
  type StartDeps,
} from "../distillation/public.ts";

import { isAutomatedTestProcess, isBuildProcess } from "@/shared/utils/testProcess";

interface ExecutorLike {
  execute(input: ExecuteInput): Promise<ExecutorExecuteResult>;
}

export interface ProductionExecutorFactoryOptions {
  getExecutor(provider: string): ExecutorLike;
  getProviderCredentials(
    provider: string,
    excludeConnectionId: string | null,
    allowedConnections: string[] | null,
    requestedModel: string | null
  ): Promise<unknown>;
  getPricingForModel(provider: string, model: string): Promise<Record<string, unknown> | null>;
  breaker?: ExecutorBreakerHook;
}

interface SettingLike {
  value: string;
}

export interface ProductionSelectorFactoryOptions {
  env?: NodeJS.ProcessEnv;
  getSetting(key: string): SettingLike | null;
  getProviderConnections(filter: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  getSyncedAvailableModels(provider: string): Promise<Array<{ id: string }>>;
  getModelIsDeleted(provider: string, model: string): boolean;
}

interface StartProductionOptions {
  executor?: ExecutorDeps;
  selector?: SelectorDeps;
  startWorker?: (deps: StartDeps) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  /** Test-only: bypass automated-test detection while preserving all other gates. */
  allowAutomatedTestProcess?: boolean;
  createExecutorDeps?: () => Promise<ExecutorDeps>;
  createSelectorDeps?: () => Promise<SelectorDeps>;
}

const SELECTOR_GLOBAL_KEY = "distillation.selector.global";
const SELECTOR_PER_KEY_PREFIX = "distillation.selector.per-key.";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function finiteNonNegative(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function optionalPerKToken(value: unknown): number | undefined {
  const perMillion = finiteNonNegative(value);
  return perMillion > 0 ? perMillion / 1000 : undefined;
}

function isCredentialsSentinel(value: JsonRecord): boolean {
  return value.allRateLimited === true || value.allExpired === true;
}

function readTextParts(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const record = asRecord(part);
      if (!record) return "";
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractResponseText(payload: JsonRecord): string {
  if (typeof payload.output_text === "string") return payload.output_text;

  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const choice = asRecord(choices[0]);
  const message = asRecord(choice?.message);
  if (typeof message?.content === "string") return message.content;
  const messageParts = readTextParts(message?.content);
  if (messageParts) return messageParts;

  const content = readTextParts(payload.content);
  if (content) return content;

  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const candidate = asRecord(candidates[0]);
  const candidateContent = asRecord(candidate?.content);
  const candidateParts = readTextParts(candidateContent?.parts);
  if (candidateParts) return candidateParts;

  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    const outputItem = asRecord(item);
    const text = readTextParts(outputItem?.content);
    if (text) return text;
  }

  return "";
}

function extractUsage(payload: JsonRecord): {
  promptTokens: number;
  completionTokens: number;
} {
  const usage = asRecord(payload.usage) ?? {};
  const usageMetadata = asRecord(payload.usageMetadata) ?? {};
  return {
    promptTokens: finiteNonNegative(
      usage.prompt_tokens ??
        usage.input_tokens ??
        usage.promptTokens ??
        usage.inputTokens ??
        usageMetadata.promptTokenCount
    ),
    completionTokens: finiteNonNegative(
      usage.completion_tokens ??
        usage.output_tokens ??
        usage.completionTokens ??
        usage.outputTokens ??
        usageMetadata.candidatesTokenCount
    ),
  };
}

function responseFromExecutorResult(result: ExecutorExecuteResult): Response {
  return result instanceof Response ? result : result.response;
}

function makeHttpError(status: number): Error & { status: number } {
  const error = new Error(`Distillation upstream returned HTTP ${status}`) as Error & {
    status?: number;
  };
  error.status = status;
  return error as Error & { status: number };
}

export function createProductionExecutorDeps(
  options: ProductionExecutorFactoryOptions
): ExecutorDeps {
  const resolveExecutor = options.getExecutor;
  const resolveProviderCredentials = options.getProviderCredentials;
  const resolvePricing = options.getPricingForModel;

  return {
    breaker: options.breaker ?? makeProductionBreakerHook(),

    async resolveCredentials(provider, model) {
      const resolved = asRecord(await resolveProviderCredentials(provider, null, null, model));
      if (!resolved || isCredentialsSentinel(resolved)) return null;

      let pricing: Record<string, unknown> | null = null;
      try {
        pricing = await resolvePricing(provider, model);
      } catch {
        // Pricing is best-effort; unavailable pricing must not make valid
        // credentials unusable.
      }

      return {
        provider,
        credentials: resolved as ProviderCredentials,
        costPerKTokenIn: optionalPerKToken(pricing?.input),
        costPerKTokenOut: optionalPerKToken(pricing?.output),
      };
    },

    async runModelCall(args) {
      const body = {
        model: args.model,
        messages: args.messages,
        stream: false,
        max_tokens: args.maxTokens,
      };
      const result = await resolveExecutor(args.provider).execute({
        model: args.model,
        body,
        stream: false,
        credentials: args.credentials,
        upstreamExtraHeaders: { ...args.internalHeaders },
      });
      const response = responseFromExecutorResult(result);
      if (!response.ok) throw makeHttpError(response.status);
      const payload = asRecord(await response.json());
      if (!payload) throw new Error("Distillation upstream returned invalid JSON");
      return {
        text: extractResponseText(payload),
        ...extractUsage(payload),
      };
    },
  };
}

function parseSelectorSetting(value: string | null): {
  provider: string;
  model: string;
} | null {
  if (!value) return null;
  try {
    const parsed = asRecord(JSON.parse(value));
    const provider = typeof parsed?.provider === "string" ? parsed.provider.trim() : "";
    const model = typeof parsed?.modelId === "string" ? parsed.modelId.trim() : "";
    return provider && model ? { provider, model } : null;
  } catch {
    return null;
  }
}

export function createProductionSelectorDeps(
  options: ProductionSelectorFactoryOptions
): SelectorDeps {
  const readSetting = options.getSetting;
  const listConnections = options.getProviderConnections;
  const listModels = options.getSyncedAvailableModels;
  const isDeleted = options.getModelIsDeleted;

  return {
    env: options.env ?? process.env,

    async resolvePerKeySettings(scope) {
      return parseSelectorSetting(readSetting(`${SELECTOR_PER_KEY_PREFIX}${scope}`)?.value ?? null);
    },

    async resolveGlobalSettings() {
      return (
        parseSelectorSetting(readSetting(SELECTOR_GLOBAL_KEY)?.value ?? null) ?? {
          provider: null,
          model: null,
        }
      );
    },

    async loadCatalogSnapshot() {
      const connections = await listConnections({ isActive: true });
      const providerIds: string[] = [];
      const seen = new Set<string>();
      for (const connection of connections) {
        const provider = typeof connection.provider === "string" ? connection.provider.trim() : "";
        if (!provider || seen.has(provider)) continue;
        seen.add(provider);
        providerIds.push(provider);
      }

      const modelLists = await Promise.all(
        providerIds.map(async (provider) => {
          const models = await listModels(provider);
          const ids = models
            .map((model) => (typeof model.id === "string" ? model.id.trim() : ""))
            .filter((model) => model.length > 0 && !isDeleted(provider, model));
          return [provider, Array.from(new Set(ids))] as const;
        })
      );
      const providers = new Map<string, readonly string[]>(
        modelLists.filter(([, models]) => models.length > 0)
      );

      return {
        providers,
        isModelUsable(provider, model) {
          return providers.get(provider)?.includes(model) === true;
        },
      };
    },
  };
}

async function createDefaultProductionExecutorDeps(): Promise<ExecutorDeps> {
  const [{ getExecutor }, { getProviderCredentials }, { getPricingForModel }] = await Promise.all([
    import("@omniroute/open-sse/executors/index.ts"),
    import("@/sse/services/auth"),
    import("@/lib/db/settings/pricing"),
  ]);
  return createProductionExecutorDeps({
    getExecutor,
    getProviderCredentials,
    getPricingForModel,
  });
}

async function createDefaultProductionSelectorDeps(): Promise<SelectorDeps> {
  const [operations, providers, models] = await Promise.all([
    import("../operations.ts"),
    import("@/lib/db/providers"),
    import("@/lib/db/models"),
  ]);
  return createProductionSelectorDeps({
    env: process.env,
    getSetting: operations.getSetting,
    getProviderConnections: providers.getProviderConnections,
    getSyncedAvailableModels: models.getSyncedAvailableModels,
    getModelIsDeleted: models.getModelIsDeleted,
  });
}

function isCloudRuntime(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof globalThis.caches === "object" &&
    globalThis.caches !== null
  );
}

function productionStartAllowed(
  env: NodeJS.ProcessEnv,
  allowAutomatedTestProcess: boolean
): boolean {
  const interval = Number(env.MEMORY_DISTILLATION_INTERVAL);
  return (
    env.MEMORY_DISTILLATION_ENABLED === "true" &&
    Number.isFinite(interval) &&
    interval > 0 &&
    isWorkerStartAllowed(
      env,
      isBuildProcess(env),
      isCloudRuntime(),
      allowAutomatedTestProcess ? false : isAutomatedTestProcess(undefined, env)
    )
  );
}

export async function startProductionDistillationWorker(
  options: StartProductionOptions = {}
): Promise<boolean> {
  const env = options.env ?? process.env;
  if (!productionStartAllowed(env, options.allowAutomatedTestProcess === true)) return false;
  const startWorker = options.startWorker ?? startDistillationWorker;
  return startWorker({
    executor: options.executor,
    selector: options.selector,
    createExecutorDeps: options.createExecutorDeps ?? createDefaultProductionExecutorDeps,
    createSelectorDeps: options.createSelectorDeps ?? createDefaultProductionSelectorDeps,
    env,
    runtime: options.allowAutomatedTestProcess ? { allowAutomatedTestProcess: true } : undefined,
  });
}
