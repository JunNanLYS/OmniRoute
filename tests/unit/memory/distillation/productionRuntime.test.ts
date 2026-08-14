import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  ExecuteInput,
  ExecutorExecuteResult,
  ProviderCredentials,
} from "@omniroute/open-sse/executors/base.ts";
import type {
  ExecutorBreakerHook,
  ExecutorDeps,
  SelectorDeps,
  StartDeps,
} from "../../../../src/memory/distillation/public.ts";
import type {
  L0MessageRecord,
  L1TaskEnqueuer,
} from "../../../../src/memory/integration/l0Capture.ts";
import type { EnqueueDistillationTaskInput } from "../../../../src/memory/db/repositories/distillation.ts";

type ExecutorLike = {
  execute(input: ExecuteInput): Promise<ExecutorExecuteResult>;
};

type ProductionExecutorFactoryOptions = {
  getExecutor(provider: string): ExecutorLike;
  getProviderCredentials(
    provider: string,
    excludeConnectionId: string | null,
    allowedConnections: string[] | null,
    requestedModel: string | null
  ): Promise<unknown>;
  getPricingForModel(provider: string, model: string): Promise<Record<string, unknown> | null>;
  breaker?: ExecutorBreakerHook;
};

type SettingRow = { value: string } | null;
type ProductionSelectorFactoryOptions = {
  env?: NodeJS.ProcessEnv;
  getSetting(key: string): SettingRow;
  getProviderConnections(filter: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  getSyncedAvailableModels(provider: string): Promise<Array<{ id: string }>>;
  getModelIsDeleted(provider: string, model: string): boolean;
};

type ProductionRuntimeModule = {
  createProductionExecutorDeps(options: ProductionExecutorFactoryOptions): ExecutorDeps;
  createProductionSelectorDeps(options: ProductionSelectorFactoryOptions): SelectorDeps;
  createProductionL1TaskEnqueuer(options?: {
    enqueueTask?: (input: EnqueueDistillationTaskInput) => unknown;
    env?: NodeJS.ProcessEnv;
  }): L1TaskEnqueuer;
  startProductionDistillationWorker(options?: {
    executor?: ExecutorDeps;
    selector?: SelectorDeps;
    startWorker?: (deps: StartDeps) => Promise<boolean>;
    env?: NodeJS.ProcessEnv;
    allowAutomatedTestProcess?: boolean;
    createExecutorDeps?: () => Promise<ExecutorDeps>;
    createSelectorDeps?: () => Promise<SelectorDeps>;
  }): Promise<boolean>;
};

const modulePath = "../../../../src/memory/integration/distillationRuntime.ts";
const queueModulePath = "../../../../src/memory/integration/distillationQueue.ts";
const productionModule = (await import(modulePath).catch(
  () => null
)) as ProductionRuntimeModule | null;
const productionQueueModule = (await import(queueModulePath).catch(() => null)) as Pick<
  ProductionRuntimeModule,
  "createProductionL1TaskEnqueuer"
> | null;

function requireProductionModule(): ProductionRuntimeModule {
  assert.ok(productionModule, "production distillation runtime module must exist");
  assert.ok(productionQueueModule, "production distillation queue module must exist");
  return { ...productionModule, ...productionQueueModule };
}

function normalCredentials(): ProviderCredentials & Record<string, unknown> {
  return {
    apiKey: "test-key",
    connectionId: "connection-1",
    providerSpecificData: {},
  };
}

const CLOSED_BREAKER: ExecutorBreakerHook = {
  async isOpen() {
    return { open: false, retryAfterMs: 0 };
  },
};

describe("production distillation executor dependencies", () => {
  it("passes the selected model to credential resolution and maps configured pricing", async () => {
    const runtime = requireProductionModule();
    const credentialCalls: Array<[string, string | null]> = [];
    const deps = runtime.createProductionExecutorDeps({
      getExecutor() {
        return {
          async execute() {
            throw new Error("executor should not run during credential resolution");
          },
        };
      },
      async getProviderCredentials(provider, _excluded, _allowed, requestedModel) {
        credentialCalls.push([provider, requestedModel]);
        return normalCredentials();
      },
      async getPricingForModel() {
        return { input: 1.5, output: 6 };
      },
      breaker: CLOSED_BREAKER,
    });

    const resolved = await deps.resolveCredentials("anthropic", "claude-sonnet-5");

    assert.deepEqual(credentialCalls, [["anthropic", "claude-sonnet-5"]]);
    assert.equal(resolved?.credentials?.connectionId, "connection-1");
    assert.equal(resolved?.costPerKTokenIn, 0.0015);
    assert.equal(resolved?.costPerKTokenOut, 0.006);
  });

  it("rejects rate-limited and expired credential sentinel objects", async () => {
    const runtime = requireProductionModule();
    const sentinels: unknown[] = [{ allRateLimited: true }, { allExpired: true }, null];
    let index = 0;
    const deps = runtime.createProductionExecutorDeps({
      getExecutor() {
        return {
          async execute() {
            throw new Error("executor should not run during credential resolution");
          },
        };
      },
      async getProviderCredentials() {
        return sentinels[index++];
      },
      async getPricingForModel() {
        return null;
      },
      breaker: CLOSED_BREAKER,
    });

    assert.equal(await deps.resolveCredentials("openai", "gpt-4o-mini"), null);
    assert.equal(await deps.resolveCredentials("openai", "gpt-4o-mini"), null);
    assert.equal(await deps.resolveCredentials("openai", "gpt-4o-mini"), null);
  });

  it("calls the executor directly with internal headers and parses OpenAI usage", async () => {
    const runtime = requireProductionModule();
    let captured: ExecuteInput | null = null;
    const deps = runtime.createProductionExecutorDeps({
      getExecutor(provider) {
        assert.equal(provider, "openai");
        return {
          async execute(input) {
            captured = input;
            return {
              response: new Response(
                JSON.stringify({
                  choices: [{ message: { content: '{"facts":[]}' } }],
                  usage: { prompt_tokens: 21, completion_tokens: 8 },
                }),
                { status: 200, headers: { "content-type": "application/json" } }
              ),
            };
          },
        };
      },
      async getProviderCredentials() {
        return normalCredentials();
      },
      async getPricingForModel() {
        return null;
      },
      breaker: CLOSED_BREAKER,
    });
    const internalHeaders = {
      "x-omniroute-no-memory": "true",
      "x-omniroute-internal-marker": "signed-marker",
    };

    const result = await deps.runModelCall({
      provider: "openai",
      credentials: normalCredentials(),
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "extract facts" }],
      maxTokens: 321,
      isInternal: true,
      internalHeaders,
    });

    assert.equal(result.text, '{"facts":[]}');
    assert.equal(result.promptTokens, 21);
    assert.equal(result.completionTokens, 8);
    assert.ok(captured);
    assert.equal(captured.model, "gpt-4o-mini");
    assert.equal(captured.stream, false);
    assert.deepEqual(captured.upstreamExtraHeaders, internalHeaders);
    assert.deepEqual(captured.body, {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "extract facts" }],
      stream: false,
      max_tokens: 321,
    });
  });

  it("parses Gemini text and usage metadata", async () => {
    const runtime = requireProductionModule();
    const deps = runtime.createProductionExecutorDeps({
      getExecutor() {
        return {
          async execute() {
            return {
              response: new Response(
                JSON.stringify({
                  candidates: [{ content: { parts: [{ text: '{"summary":"short"}' }] } }],
                  usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
                }),
                { status: 200, headers: { "content-type": "application/json" } }
              ),
            };
          },
        };
      },
      async getProviderCredentials() {
        return normalCredentials();
      },
      async getPricingForModel() {
        return null;
      },
      breaker: CLOSED_BREAKER,
    });

    const result = await deps.runModelCall({
      provider: "gemini",
      credentials: normalCredentials(),
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "summarize" }],
      maxTokens: 200,
      isInternal: true,
      internalHeaders: { "x-omniroute-no-memory": "true" },
    });

    assert.equal(result.text, '{"summary":"short"}');
    assert.equal(result.promptTokens, 9);
    assert.equal(result.completionTokens, 4);
  });

  it("accepts a bare Response and parses Anthropic text and usage", async () => {
    const runtime = requireProductionModule();
    const deps = runtime.createProductionExecutorDeps({
      getExecutor() {
        return {
          async execute() {
            return new Response(
              JSON.stringify({
                content: [{ type: "text", text: '{"persona":"builder"}' }],
                usage: { input_tokens: 13, output_tokens: 5 },
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            );
          },
        };
      },
      async getProviderCredentials() {
        return normalCredentials();
      },
      async getPricingForModel() {
        return null;
      },
      breaker: CLOSED_BREAKER,
    });

    const result = await deps.runModelCall({
      provider: "anthropic",
      credentials: normalCredentials(),
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "classify" }],
      maxTokens: 200,
      isInternal: true,
      internalHeaders: { "x-omniroute-no-memory": "true" },
    });

    assert.equal(result.text, '{"persona":"builder"}');
    assert.equal(result.promptTokens, 13);
    assert.equal(result.completionTokens, 5);
  });
});

describe("production distillation selector dependencies", () => {
  it("maps persisted modelId settings and builds an active synced catalog", async () => {
    const runtime = requireProductionModule();
    const settingValues = new Map<string, string>([
      [
        "distillation.selector.per-key.owner-1",
        JSON.stringify({ provider: "openai", modelId: "gpt-4o-mini" }),
      ],
      [
        "distillation.selector.global",
        JSON.stringify({ provider: "anthropic", modelId: "claude-sonnet-5" }),
      ],
    ]);
    const deps = runtime.createProductionSelectorDeps({
      env: { MEMORY_DISTILLATION_MODEL: "env/model" },
      getSetting(key) {
        const value = settingValues.get(key);
        return value === undefined ? null : { value };
      },
      async getProviderConnections(filter) {
        assert.deepEqual(filter, { isActive: true });
        return [
          { provider: "openai", isActive: true },
          { provider: "anthropic", isActive: true },
          { provider: "openai", isActive: true },
        ];
      },
      async getSyncedAvailableModels(provider) {
        return provider === "openai"
          ? [{ id: "gpt-4o-mini" }, { id: "deleted-model" }]
          : [{ id: "claude-sonnet-5" }];
      },
      getModelIsDeleted(_provider, model) {
        return model === "deleted-model";
      },
    });

    assert.deepEqual(await deps.resolvePerKeySettings("owner-1"), {
      provider: "openai",
      model: "gpt-4o-mini",
    });
    assert.deepEqual(await deps.resolveGlobalSettings(), {
      provider: "anthropic",
      model: "claude-sonnet-5",
    });

    const catalog = await deps.loadCatalogSnapshot();
    assert.deepEqual(
      [...catalog.providers],
      [
        ["openai", ["gpt-4o-mini"]],
        ["anthropic", ["claude-sonnet-5"]],
      ]
    );
    assert.equal(catalog.isModelUsable("openai", "gpt-4o-mini"), true);
    assert.equal(catalog.isModelUsable("openai", "deleted-model"), false);
    assert.equal(catalog.isModelUsable("missing", "model"), false);
  });
});

describe("production L0 to L1 handoff", () => {
  it("does not enqueue while distillation is not doubly enabled", async () => {
    const runtime = requireProductionModule();
    let calls = 0;
    const enqueuer = runtime.createProductionL1TaskEnqueuer({
      env: { MEMORY_DISTILLATION_ENABLED: "false", MEMORY_DISTILLATION_INTERVAL: "60" },
      enqueueTask() {
        calls++;
      },
    });

    await enqueuer.enqueueL1Task({
      ownerId: "owner-1",
      sessionId: "session-1",
      correlationId: null,
      capturedAt: "2026-08-13T10:00:00.000Z",
      records: [],
    });

    assert.equal(calls, 0);
  });

  it("enqueues an executable L1 task from the captured message batch", async () => {
    const runtime = requireProductionModule();
    let enqueued: EnqueueDistillationTaskInput | null = null;
    const enqueuer = runtime.createProductionL1TaskEnqueuer({
      env: {
        MEMORY_DISTILLATION_ENABLED: "true",
        MEMORY_DISTILLATION_INTERVAL: "60",
      },
      enqueueTask(input) {
        enqueued = input;
        return { id: "task-1" };
      },
    });
    const records: L0MessageRecord[] = [
      {
        id: "l0-user",
        ownerId: "owner-1",
        sessionId: "session-1",
        role: "user",
        content: "I prefer concise answers.",
        metadata: {
          session_key: "session-1",
          pipelineSessionId: "session-1",
          user_id: "owner-1",
          role: "user",
          source: "chat",
          timestamp: "2026-08-13T10:00:00.000Z",
          correlation_id: "corr-1",
          combo_execution_key: null,
          is_internal: false,
          provider: "openai",
          model: "gpt-4o-mini",
        },
        createdAt: "2026-08-13T10:00:00.000Z",
      },
      {
        id: "l0-assistant",
        ownerId: "owner-1",
        sessionId: "session-1",
        role: "assistant",
        content: "Understood. I will be concise.",
        metadata: {
          session_key: "session-1",
          pipelineSessionId: "session-1",
          user_id: "owner-1",
          role: "assistant",
          source: "chat",
          timestamp: "2026-08-13T10:00:00.000Z",
          correlation_id: "corr-1",
          combo_execution_key: null,
          is_internal: false,
          provider: "openai",
          model: "gpt-4o-mini",
        },
        createdAt: "2026-08-13T10:00:00.000Z",
      },
    ];

    await enqueuer.enqueueL1Task({
      ownerId: "owner-1",
      sessionId: "session-1",
      correlationId: "corr-1",
      capturedAt: "2026-08-13T10:00:00.000Z",
      records,
    });

    assert.ok(enqueued);
    assert.equal(enqueued.kind, "L1_extract");
    assert.equal(enqueued.scope, "owner-1");
    assert.equal(enqueued.priority, 1);
    assert.deepEqual(enqueued.payload, {
      sessionId: "session-1",
      correlationId: "corr-1",
      capturedAt: "2026-08-13T10:00:00.000Z",
      sourceMessageIds: ["l0-user", "l0-assistant"],
      conversation: "user: I prefer concise answers.\nassistant: Understood. I will be concise.",
    });
    assert.ok((enqueued.notBefore ?? 0) > 0);
  });
});

describe("production distillation worker composition", () => {
  it("pre-gates disabled/background-disabled startup before constructing dependencies", async () => {
    const runtime = requireProductionModule();
    for (const env of [
      { MEMORY_DISTILLATION_ENABLED: "false", MEMORY_DISTILLATION_INTERVAL: "60" },
      {
        MEMORY_DISTILLATION_ENABLED: "true",
        MEMORY_DISTILLATION_INTERVAL: "60",
        OMNIROUTE_DISABLE_BACKGROUND_SERVICES: "true",
      },
    ]) {
      let dependencyCalls = 0;
      let startCalls = 0;
      const started = await runtime.startProductionDistillationWorker({
        env,
        allowAutomatedTestProcess: true,
        async createExecutorDeps() {
          dependencyCalls++;
          return {} as ExecutorDeps;
        },
        async createSelectorDeps() {
          dependencyCalls++;
          return {} as SelectorDeps;
        },
        async startWorker() {
          startCalls++;
          return true;
        },
      });
      assert.equal(started, false);
      assert.equal(dependencyCalls, 0);
      assert.equal(startCalls, 0);
    }
  });

  it("hands dependency factories to the worker without resolving them first", async () => {
    const runtime = requireProductionModule();
    let factoryCalls = 0;
    let received: StartDeps | null = null;

    const started = await runtime.startProductionDistillationWorker({
      env: {
        MEMORY_DISTILLATION_ENABLED: "true",
        MEMORY_DISTILLATION_INTERVAL: "60",
      },
      allowAutomatedTestProcess: true,
      async createExecutorDeps() {
        factoryCalls++;
        return {} as ExecutorDeps;
      },
      async createSelectorDeps() {
        factoryCalls++;
        return {} as SelectorDeps;
      },
      async startWorker(deps) {
        received = deps;
        return false;
      },
    });

    const lazy = received as
      | (StartDeps & {
          createExecutorDeps?: () => Promise<ExecutorDeps>;
          createSelectorDeps?: () => Promise<SelectorDeps>;
        })
      | null;
    assert.equal(started, false);
    assert.equal(factoryCalls, 0);
    assert.equal(typeof lazy?.createExecutorDeps, "function");
    assert.equal(typeof lazy?.createSelectorDeps, "function");
  });

  it("starts the worker with both production dependency sets", async () => {
    const runtime = requireProductionModule();
    const executor = {
      breaker: CLOSED_BREAKER,
      async resolveCredentials() {
        return null;
      },
      async runModelCall() {
        return { text: "", promptTokens: 0, completionTokens: 0 };
      },
    } satisfies ExecutorDeps;
    const selector = {
      async resolvePerKeySettings() {
        return null;
      },
      async resolveGlobalSettings() {
        return { provider: null, model: null };
      },
      async loadCatalogSnapshot() {
        return { providers: new Map(), isModelUsable: () => false };
      },
      env: {},
    } satisfies SelectorDeps;
    let received: StartDeps | null = null;

    const started = await runtime.startProductionDistillationWorker({
      executor,
      selector,
      env: {
        MEMORY_DISTILLATION_ENABLED: "true",
        MEMORY_DISTILLATION_INTERVAL: "60",
      },
      allowAutomatedTestProcess: true,
      async startWorker(deps) {
        received = deps;
        return true;
      },
    });

    assert.equal(started, true);
    assert.ok(received);
    assert.equal(received.executor, executor);
    assert.equal(received.selector, selector);
  });
});
