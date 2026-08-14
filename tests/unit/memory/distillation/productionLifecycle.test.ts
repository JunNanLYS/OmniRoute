import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

type CleanupDeps = {
  stopDistillationWorker(): Promise<void>;
  flushSpendBatchWriter(): Promise<{ flushedEntries: number }>;
  closeAuditDb(): boolean;
  closeMemoryDbInstance(): boolean;
  closeDbInstance(): boolean;
  closeLogRotation(): void;
  logger: Pick<Console, "log" | "warn">;
};

type ShutdownModule = {
  runStorageCleanup?: (deps: CleanupDeps) => Promise<void>;
};

describe("memory distillation production lifecycle wiring", () => {
  it("stops the worker before closing memory.db and the main database", async () => {
    const shutdown = (await import("../../../../src/lib/gracefulShutdown.ts")) as ShutdownModule;
    assert.equal(typeof shutdown.runStorageCleanup, "function");

    const events: string[] = [];
    await shutdown.runStorageCleanup!({
      async stopDistillationWorker() {
        events.push("stop-worker");
      },
      async flushSpendBatchWriter() {
        events.push("flush-spend");
        return { flushedEntries: 0 };
      },
      closeAuditDb() {
        events.push("close-audit");
        return true;
      },
      closeMemoryDbInstance() {
        events.push("close-memory-db");
        return true;
      },
      closeDbInstance() {
        events.push("close-main-db");
        return true;
      },
      closeLogRotation() {
        events.push("close-log-rotation");
      },
      logger: { log() {}, warn() {} },
    });

    assert.deepEqual(events, [
      "stop-worker",
      "flush-spend",
      "close-audit",
      "close-memory-db",
      "close-main-db",
      "close-log-rotation",
    ]);
  });

  it("continues database cleanup when stopping the worker fails", async () => {
    const shutdown = (await import("../../../../src/lib/gracefulShutdown.ts")) as ShutdownModule;
    assert.equal(typeof shutdown.runStorageCleanup, "function");

    const events: string[] = [];
    const warnings: string[] = [];
    await assert.doesNotReject(() =>
      shutdown.runStorageCleanup!({
        async stopDistillationWorker() {
          events.push("stop-worker");
          throw new Error("simulated stop failure");
        },
        async flushSpendBatchWriter() {
          events.push("flush-spend");
          return { flushedEntries: 0 };
        },
        closeAuditDb() {
          events.push("close-audit");
          return false;
        },
        closeMemoryDbInstance() {
          events.push("close-memory-db");
          return false;
        },
        closeDbInstance() {
          events.push("close-main-db");
          return false;
        },
        closeLogRotation() {
          events.push("close-log-rotation");
        },
        logger: {
          log() {},
          warn(...args) {
            warnings.push(args.map(String).join(" "));
          },
        },
      })
    );

    assert.deepEqual(events, [
      "stop-worker",
      "flush-spend",
      "close-audit",
      "close-memory-db",
      "close-main-db",
      "close-log-rotation",
    ]);
    assert.ok(warnings.some((line) => line.includes("simulated stop failure")));
  });

  it("exposes an idempotent standalone memory database close operation", async () => {
    const core = await import("../../../../src/memory/db/core.ts");
    assert.equal(typeof core.closeMemoryDbInstance, "function");
    assert.equal(core.closeMemoryDbInstance(), false);
  });

  it("starts distillation after runtime settings hydration and before readiness", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/instrumentation-node.ts"), "utf8");
    const hydrate = source.indexOf("applyRuntimeSettings(settings");
    const start = source.indexOf("startProductionDistillationWorker");
    const ready = source.lastIndexOf("markServerReady()");

    assert.ok(hydrate >= 0, "runtime settings hydration call must remain present");
    assert.ok(start > hydrate, "distillation must start after settings hydration");
    assert.ok(ready > start, "server readiness must be marked after distillation startup attempt");
  });

  it("ships the standalone memory runtime in the npm package allowlist", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      files?: string[];
    };
    assert.ok(pkg.files?.includes("src/memory/"), "package files must include src/memory/");
  });
});
