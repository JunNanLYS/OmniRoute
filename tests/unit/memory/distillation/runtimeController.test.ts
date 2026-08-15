import test from "node:test";
import assert from "node:assert/strict";

const controller = await import("../../../../src/memory/distillation/runtimeController.ts");
const worker = await import("../../../../src/memory/distillation/worker.ts");

test.after(() => {
  worker.__resetDistillationWorkerForTests();
});

test("runtime controller reports stopped state", () => {
  worker.__resetDistillationWorkerForTests();
  assert.deepEqual(controller.getDistillationWorkerStatus(), {
    state: "stopped",
    activeTasks: 0,
    configuredIntervalSeconds: null,
    configuredConcurrency: null,
  });
});

test("runtime controller disables the worker without starting it", async () => {
  let started = false;
  const status = await controller.reconcileDistillationWorker(
    { enabled: false, intervalSeconds: 60, concurrency: 1 },
    {
      async startWorker() {
        started = true;
        return true;
      },
    }
  );
  assert.equal(started, false);
  assert.equal(status.state, "stopped");
});

test("runtime controller reports running state with configured interval and concurrency", async () => {
  worker.__resetDistillationWorkerForTests();
  const store = new worker.InMemoryDistillationStore();
  const selector = {
    resolvePerKeySettings: async () => ({ provider: null, model: null }),
    resolveGlobalSettings: async () => ({ provider: "openai", model: "gpt-4o-mini" }),
    loadCatalogSnapshot: async () => ({
      providers: new Map([["openai", ["gpt-4o-mini"]]]),
      isModelUsable: () => true,
    }),
    env: {},
  };
  const executor = {
    breaker: { isOpen: async () => ({ open: false, retryAfterMs: 0 }) },
    resolveCredentials: async () => ({
      provider: "openai",
      credentials: {} as never,
    }),
    runModelCall: async () => ({ text: "{}", promptTokens: 0, completionTokens: 0 }),
  };
  const started = await worker.startDistillationWorker({
    store,
    executor: executor as never,
    selector: selector as never,
    env: {
      MEMORY_DISTILLATION_ENABLED: "true",
      MEMORY_DISTILLATION_INTERVAL: "60",
      MEMORY_DISTILLATION_CONCURRENCY: "3",
      MEMORY_DISTILLATION_SECRET: "runtime-controller-secret-16-bytes",
    },
    runtime: { allowAutomatedTestProcess: true, scheduleTimers: false },
  });
  assert.equal(started, true);
  try {
    assert.deepEqual(controller.getDistillationWorkerStatus(), {
      state: "running",
      activeTasks: 0,
      configuredIntervalSeconds: 60,
      configuredConcurrency: 3,
    });
  } finally {
    await worker.stopDistillationWorker({ force: true, graceMs: 500 });
    worker.__resetDistillationWorkerForTests();
  }
  assert.equal(controller.getDistillationWorkerStatus().state, "stopped");
});

test("runtime controller enables the worker through the injected starter with merged env", async () => {
  const captured: Array<NodeJS.ProcessEnv | undefined> = [];
  const status = await controller.reconcileDistillationWorker(
    { enabled: true, intervalSeconds: 120, concurrency: 2 },
    {
      async startWorker(deps) {
        captured.push(deps.env);
        return true;
      },
    }
  );
  assert.equal(captured.length, 1, "enabling must call the injected starter exactly once");
  assert.equal(captured[0]?.MEMORY_DISTILLATION_ENABLED, "true");
  assert.equal(captured[0]?.MEMORY_DISTILLATION_INTERVAL, "120");
  assert.equal(captured[0]?.MEMORY_DISTILLATION_CONCURRENCY, "2");
  assert.equal(status.state, "stopped", "injected starter installs no real worker global");
});
