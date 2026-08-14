import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  startDistillationWorker,
  stopDistillationWorker,
  tickOnce,
  __resetDistillationWorkerForTests,
  InMemoryDistillationStore,
} from "../../../../src/memory/distillation/public.ts";
import { resolveDistillationConfig } from "../../../../src/memory/distillation/config.ts";
import { verifyInternalMarker } from "../../../../src/memory/distillation/internalMarker.ts";
import type {
  DistillationHandler,
  DistillationTask,
  ExecutorDeps,
  SelectorDeps,
} from "../../../../src/memory/distillation/public.ts";

const TEST_SECRET = "worker-test-secret-at-least-16-bytes";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeTask(over: Partial<DistillationTask> = {}): DistillationTask {
  return {
    id: over.id ?? "t1",
    kind: "L1_extract",
    scope: over.scope ?? "scope-A",
    payload: over.payload ?? { conversation: "I prefer dark mode." },
    priority: over.priority ?? 0,
    attempt: over.attempt ?? 0,
    notBefore: over.notBefore ?? 0,
    status: over.status ?? "queued",
    providerHint: over.providerHint ?? null,
    modelHint: over.modelHint ?? null,
    lastError: over.lastError ?? null,
    version: over.version ?? 1,
  };
}

function makeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MEMORY_DISTILLATION_ENABLED: "true",
    MEMORY_DISTILLATION_INTERVAL: "60",
    MEMORY_DISTILLATION_CONCURRENCY: "3",
    MEMORY_DISTILLATION_SECRET: TEST_SECRET,
    ...overrides,
  };
}

function makeSelector(
  options: {
    provider?: string;
    model?: string;
    catalogModels?: string[];
    usable?: boolean;
  } = {}
): SelectorDeps {
  const provider = options.provider ?? "openai";
  const model = options.model ?? "gpt-4o-mini";
  return {
    resolvePerKeySettings: async () => ({ provider: null, model: null }),
    resolveGlobalSettings: async () => ({ provider, model }),
    loadCatalogSnapshot: async () => ({
      providers: new Map<string, readonly string[]>([[provider, options.catalogModels ?? [model]]]),
      isModelUsable: () => options.usable ?? true,
    }),
    env: {} as NodeJS.ProcessEnv,
  };
}

function makeExecutor(
  options: {
    breakerOpen?: boolean;
    credentials?: boolean;
    run?: ExecutorDeps["runModelCall"];
  } = {}
): ExecutorDeps {
  return {
    breaker: {
      isOpen: async () => ({
        open: options.breakerOpen ?? false,
        retryAfterMs: 5_000,
      }),
    },
    resolveCredentials: async () =>
      options.credentials === false
        ? null
        : {
            provider: "openai",
            credentials: {} as never,
            costPerKTokenIn: 0.00015,
            costPerKTokenOut: 0.0006,
          },
    runModelCall:
      options.run ??
      (async () => ({
        text: JSON.stringify([
          {
            scene_name: "preferences",
            message_ids: ["l0-user"],
            memories: [
              {
                content: "Prefers dark mode",
                type: "persona",
                priority: 80,
                source_message_ids: ["l0-user"],
                metadata: { key: "theme" },
              },
            ],
          },
        ]),
        promptTokens: 10,
        completionTokens: 5,
      })),
  };
}

async function startForTest(input: {
  store: InMemoryDistillationStore;
  executor?: ExecutorDeps;
  selector?: SelectorDeps;
  handlers?: Partial<Record<DistillationTask["kind"], DistillationHandler>>;
  env?: NodeJS.ProcessEnv;
  taskLeaseRenewMs?: number;
  taskLeaseMs?: number;
}): Promise<boolean> {
  return startDistillationWorker({
    store: input.store,
    executor: input.executor ?? makeExecutor(),
    selector: input.selector ?? makeSelector(),
    handlers: input.handlers,
    env: input.env ?? makeEnv(),
    runtime: {
      allowAutomatedTestProcess: true,
      scheduleTimers: false,
      taskLeaseRenewMs: input.taskLeaseRenewMs,
      taskLeaseMs: input.taskLeaseMs,
    },
  });
}

function defineHandler(
  fn: Parameters<typeof Object.assign>[0] extends never
    ? never
    : (args: Parameters<DistillationHandler>[0]) => ReturnType<DistillationHandler>
): DistillationHandler {
  const handler = fn as DistillationHandler;
  Object.defineProperty(handler, "kind", { value: "L1_extract" });
  return handler;
}

afterEach(async () => {
  await stopDistillationWorker({ force: true, graceMs: 1_000 });
  __resetDistillationWorkerForTests();
});

describe("distillation/worker — start gates", () => {
  it("requires an explicit positive interval in addition to enabled=true", async () => {
    const withoutInterval = await startForTest({
      store: new InMemoryDistillationStore(),
      env: makeEnv({ MEMORY_DISTILLATION_INTERVAL: undefined }),
    });
    assert.equal(withoutInterval, false);

    const zeroInterval = await startForTest({
      store: new InMemoryDistillationStore(),
      env: makeEnv({ MEMORY_DISTILLATION_INTERVAL: "0" }),
    });
    assert.equal(zeroInterval, false);
  });

  it("honors all background-service disable spellings", async () => {
    for (const value of ["1", "true", "yes", "on"]) {
      const started = await startForTest({
        store: new InMemoryDistillationStore(),
        env: makeEnv({ OMNIROUTE_DISABLE_BACKGROUND_SERVICES: value }),
      });
      assert.equal(started, false, `disable value ${value}`);
    }
  });
  it("allows only one concurrent startup while the catalog loads", async () => {
    const gate = deferred();
    let catalogLoads = 0;
    const selector = makeSelector();
    selector.loadCatalogSnapshot = async () => {
      catalogLoads++;
      await gate.promise;
      return { providers: new Map(), isModelUsable: () => false };
    };
    const input = {
      store: new InMemoryDistillationStore(),
      executor: makeExecutor(),
      selector,
      env: makeEnv(),
      runtime: { allowAutomatedTestProcess: true, scheduleTimers: false },
    };

    const first = startDistillationWorker(input);
    const second = startDistillationWorker(input);
    await Promise.resolve();
    gate.resolve();

    assert.deepEqual(await Promise.all([first, second]), [true, false]);
    assert.equal(catalogLoads, 1);
  });

  it("cancels startup when shutdown begins during catalog loading", async () => {
    const gate = deferred();
    const selector = makeSelector();
    selector.loadCatalogSnapshot = async () => {
      await gate.promise;
      return { providers: new Map(), isModelUsable: () => false };
    };
    const starting = startDistillationWorker({
      store: new InMemoryDistillationStore(),
      executor: makeExecutor(),
      selector,
      env: makeEnv(),
      runtime: { allowAutomatedTestProcess: true, scheduleTimers: false },
    });
    await Promise.resolve();

    const stopping = stopDistillationWorker({ force: true, graceMs: 1_000 });
    gate.resolve();

    assert.equal(await starting, false);
    await stopping;
    assert.equal(
      await startDistillationWorker({
        store: new InMemoryDistillationStore(),
        executor: makeExecutor(),
        selector: makeSelector(),
        env: makeEnv(),
        runtime: { allowAutomatedTestProcess: true, scheduleTimers: false },
      }),
      true
    );
  });
  it("bounds shutdown while startup dependencies remain blocked", async () => {
    const entered = deferred();
    const gate = deferred();
    const selector = makeSelector();
    selector.loadCatalogSnapshot = async () => {
      entered.resolve();
      await gate.promise;
      return { providers: new Map(), isModelUsable: () => false };
    };
    const starting = startDistillationWorker({
      store: new InMemoryDistillationStore(),
      executor: makeExecutor(),
      selector,
      env: makeEnv(),
      runtime: { allowAutomatedTestProcess: true, scheduleTimers: false },
    });
    await entered.promise;

    const stopping = stopDistillationWorker({ force: true, graceMs: 20 });
    const outcome = await Promise.race([
      stopping.then(() => "stopped" as const),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 250)),
    ]);

    gate.resolve();
    assert.equal(outcome, "stopped");
    assert.equal(await starting, false);
    await stopping;
  });

  it("waits for an active tick before shutdown completes", async () => {
    const gate = deferred();
    const store = new InMemoryDistillationStore();
    store.claimNextTask = async () => {
      await gate.promise;
      return { task: null, leaseMs: 60_000 };
    };
    assert.equal(await startForTest({ store }), true);

    const ticking = tickOnce();
    await Promise.resolve();
    let stopped = false;
    const stopping = stopDistillationWorker({ force: true, graceMs: 1_000 }).then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(stopped, false);
    gate.resolve();
    await ticking;
    await stopping;
  });
});

describe("distillation/worker — end-to-end transitions", () => {
  it("persists result and priced usage, and propagates a verifiable internal marker", async () => {
    const store = new InMemoryDistillationStore();
    store.seed([makeTask()]);
    let internalHeaders: Readonly<Record<string, string>> | undefined;
    const executor = makeExecutor({
      run: async (args) => {
        internalHeaders = args.internalHeaders;
        return {
          text: JSON.stringify([
            {
              scene_name: "preferences",
              message_ids: ["l0-user"],
              memories: [
                {
                  content: "Prefers dark mode",
                  type: "persona",
                  priority: 80,
                  source_message_ids: ["l0-user"],
                  metadata: { key: "theme" },
                },
              ],
            },
          ]),
          promptTokens: 10,
          completionTokens: 5,
        };
      },
    });

    assert.equal(await startForTest({ store, executor }), true);
    await tickOnce();

    const snapshot = store.snapshot();
    assert.equal(snapshot.tasks[0]?.status, "succeeded");
    assert.deepEqual(snapshot.results[0]?.result.payload, {
      scenes: [
        {
          sceneName: "preferences",
          messageIds: ["l0-user"],
          memories: [
            {
              content: "Prefers dark mode",
              type: "persona",
              priority: 80,
              sourceMessageIds: ["l0-user"],
              metadata: { key: "theme" },
            },
          ],
        },
      ],
    });
    assert.equal(snapshot.usage.length, 1);
    assert.equal(snapshot.usage[0]?.tokens, 15);
    assert.ok(Math.abs((snapshot.usage[0]?.usd ?? 0) - 0.0000045) < 1e-12);

    assert.ok(internalHeaders);
    const config = resolveDistillationConfig(makeEnv());
    const marker = verifyInternalMarker(
      config.secret,
      { ...internalHeaders },
      {
        maxDepth: config.maxDepth,
        maxCalls: config.maxCalls,
      }
    );
    assert.equal(marker.ok, true);
  });

  it("requeues canonical apply failures without recording usage", async () => {
    const store = new InMemoryDistillationStore();
    store.seed([makeTask({ id: "apply-failure" })]);
    (
      store as unknown as {
        completeTask(task: DistillationTask, ownerId: string, result: unknown): Promise<void>;
      }
    ).completeTask = async () => {
      throw new Error("canonical apply failed");
    };

    assert.equal(await startForTest({ store }), true);
    await tickOnce();

    const snapshot = store.snapshot();
    assert.equal(snapshot.tasks[0]?.status, "queued");
    assert.equal(snapshot.tasks[0]?.attempt, 1);
    assert.equal(snapshot.usage.length, 0);
  });

  it("DLQs deterministic canonical apply validation failures without retrying", async () => {
    const store = new InMemoryDistillationStore();
    store.seed([makeTask({ id: "invalid-apply", kind: "L2_scene" })]);
    const error = new Error("L2 result contains neither summary nor tags") as Error & {
      code?: string;
    };
    error.code = "DISTILLATION_APPLY_INVALID";
    store.completeTask = async () => {
      throw error;
    };
    const l2Handler = Object.assign(
      async () => ({
        ok: true as const,
        result: {
          payload: { summary: "", tags: [] },
          fallbackEvidence: [],
          promptTokens: 0,
          completionTokens: 0,
        },
      }),
      { kind: "L2_scene" as const }
    );

    assert.equal(await startForTest({ store, handlers: { L2_scene: l2Handler } }), true);
    await tickOnce();

    const snapshot = store.snapshot();
    assert.equal(snapshot.tasks[0]?.status, "failed_dlq");
    assert.equal(snapshot.tasks[0]?.attempt, 0);
    assert.equal(snapshot.dlq[0]?.failureKind, "semantic_invalid");
    assert.equal(snapshot.usage.length, 0);
  });

  it("renews the task lease while a long handler is running", async () => {
    const store = new InMemoryDistillationStore();
    store.seed([makeTask({ id: "long-task" })]);
    let renewals = 0;
    const originalRenew = store.renewTaskLease.bind(store);
    store.renewTaskLease = async (...args) => {
      renewals++;
      return originalRenew(...args);
    };
    const handler = defineHandler(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return {
        ok: true,
        result: {
          payload: {
            scenes: [
              {
                sceneName: "test",
                messageIds: [],
                memories: [
                  {
                    content: "Long task completed",
                    type: "episodic",
                    priority: 50,
                    sourceMessageIds: [],
                    metadata: {},
                  },
                ],
              },
            ],
          },
          fallbackEvidence: [],
          promptTokens: 0,
          completionTokens: 0,
        },
      };
    });
    assert.equal(
      await startForTest({
        store,
        handlers: { L1_extract: handler },
        taskLeaseRenewMs: 10,
        taskLeaseMs: 40,
      }),
      true
    );

    await tickOnce();

    assert.ok(renewals >= 2, `expected multiple lease renewals, got ${renewals}`);
    assert.equal(store.snapshot().tasks[0]?.status, "succeeded");
  });

  it("leaves breaker-open work queued without burning an attempt or rejecting", async () => {
    const store = new InMemoryDistillationStore();
    store.seed([makeTask({ id: "breaker" })]);
    assert.equal(
      await startForTest({ store, executor: makeExecutor({ breakerOpen: true }) }),
      true
    );

    await assert.doesNotReject(() => tickOnce());
    const snapshot = store.snapshot();
    assert.equal(snapshot.tasks[0]?.status, "queued");
    assert.equal(snapshot.tasks[0]?.attempt, 0);
    assert.ok((snapshot.tasks[0]?.notBefore ?? 0) > Date.now());
    assert.equal(snapshot.dlq.length, 0);
  });

  it("passes the selected model into credential resolution", async () => {
    const store = new InMemoryDistillationStore();
    store.seed([makeTask({ id: "model-aware-credentials" })]);
    let resolved: { provider: string; model: string } | null = null;
    const executor = makeExecutor();
    executor.resolveCredentials = async (provider, model) => {
      resolved = { provider, model };
      return {
        provider,
        credentials: {} as never,
      };
    };

    assert.equal(await startForTest({ store, executor }), true);
    await tickOnce();

    assert.deepEqual(resolved, { provider: "openai", model: "gpt-4o-mini" });
    assert.equal(store.snapshot().tasks[0]?.status, "succeeded");
  });

  it("routes missing credentials to credentials_invalid DLQ", async () => {
    const store = new InMemoryDistillationStore();
    store.seed([makeTask({ id: "credentials" })]);
    assert.equal(
      await startForTest({ store, executor: makeExecutor({ credentials: false }) }),
      true
    );

    await assert.doesNotReject(() => tickOnce());
    const snapshot = store.snapshot();
    assert.equal(snapshot.tasks[0]?.status, "failed_dlq");
    assert.equal(snapshot.dlq[0]?.failureKind, "credentials_invalid");
  });

  it("requeues retryable upstream failures with backoff", async () => {
    const store = new InMemoryDistillationStore();
    store.seed([makeTask({ id: "upstream" })]);
    const executor = makeExecutor({
      run: async () => {
        const error = new Error("upstream unavailable") as Error & { status?: number };
        error.status = 503;
        throw error;
      },
    });
    assert.equal(await startForTest({ store, executor }), true);

    await assert.doesNotReject(() => tickOnce());
    const snapshot = store.snapshot();
    assert.equal(snapshot.tasks[0]?.status, "queued");
    assert.equal(snapshot.tasks[0]?.attempt, 1);
    assert.ok((snapshot.tasks[0]?.notBefore ?? 0) > Date.now());
    assert.equal(snapshot.dlq.length, 0);
  });

  it("preserves handler parse_failed classification", async () => {
    const store = new InMemoryDistillationStore();
    store.seed([makeTask({ id: "parse" })]);
    const handler = defineHandler(async () => ({
      ok: false,
      error: { kind: "parse_failed", message: "invalid JSON" },
    }));
    assert.equal(await startForTest({ store, handlers: { L1_extract: handler } }), true);

    await tickOnce();
    const snapshot = store.snapshot();
    assert.equal(snapshot.tasks[0]?.status, "failed_dlq");
    assert.equal(snapshot.dlq[0]?.failureKind, "parse_failed");
  });

  it("rejects a selected model deleted from the catalog before execution", async () => {
    const store = new InMemoryDistillationStore();
    store.seed([makeTask({ id: "deleted" })]);
    let calls = 0;
    const executor = makeExecutor({
      run: async () => {
        calls++;
        return { text: "{}", promptTokens: 0, completionTokens: 0 };
      },
    });
    const selector = makeSelector({ catalogModels: ["another-model"] });
    assert.equal(await startForTest({ store, executor, selector }), true);

    await tickOnce();
    const snapshot = store.snapshot();
    assert.equal(calls, 0);
    assert.equal(snapshot.tasks[0]?.status, "failed_dlq");
    assert.equal(snapshot.dlq[0]?.failureKind, "model_deleted");
  });

  it("uses the configured permit capacity for independent scopes", async () => {
    const store = new InMemoryDistillationStore();
    store.seed([
      makeTask({ id: "a", scope: "scope-a" }),
      makeTask({ id: "b", scope: "scope-b" }),
      makeTask({ id: "c", scope: "scope-c" }),
    ]);
    let active = 0;
    let maxActive = 0;
    const handler = defineHandler(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return {
        ok: true,
        result: {
          payload: { facts: [] },
          fallbackEvidence: [],
          promptTokens: 0,
          completionTokens: 0,
        },
      };
    });
    assert.equal(await startForTest({ store, handlers: { L1_extract: handler } }), true);

    await tickOnce();
    assert.equal(maxActive, 3);
    assert.deepEqual(
      store.snapshot().tasks.map((task) => task.status),
      ["succeeded", "succeeded", "succeeded"]
    );
  });
});
