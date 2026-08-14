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
