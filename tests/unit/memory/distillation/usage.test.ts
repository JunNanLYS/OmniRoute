import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UsageBatcher, buildUsageRecord } from "../../../../src/memory/distillation/usage.ts";
import { InMemoryDistillationStore } from "../../../../src/memory/distillation/store.ts";

describe("distillation/usage — buildUsageRecord", () => {
  it("computes tokens + USD from prompt/completion counts and per-1k prices", () => {
    const rec = buildUsageRecord({
      taskId: "t1",
      scope: "scope-A",
      kind: "L1_extract",
      provider: "openai",
      model: "gpt-4o-mini",
      promptTokens: 1000,
      completionTokens: 500,
      costPerKTokenIn: 0.00015,
      costPerKTokenOut: 0.0006,
      now: 1_000_000,
    });
    assert.equal(rec.tokens, 1500);
    assert.equal(rec.usd, 0.00015 + 0.0003);
  });

  it("defaults USD to 0 when pricing is missing", () => {
    const rec = buildUsageRecord({
      taskId: "t1",
      scope: "scope-A",
      kind: "L1_extract",
      provider: "openai",
      model: "gpt-4o-mini",
      promptTokens: 100,
      completionTokens: 100,
    });
    assert.equal(rec.tokens, 200);
    assert.equal(rec.usd, 0);
  });

  it("clamps negative token counts to 0", () => {
    const rec = buildUsageRecord({
      taskId: "t1",
      scope: "scope-A",
      kind: "L1_extract",
      provider: "p",
      model: "m",
      promptTokens: -50,
      completionTokens: -10,
    });
    assert.equal(rec.tokens, 0);
  });
});

describe("distillation/usage — UsageBatcher", () => {
  it("enqueues + flushes records to the store", async () => {
    const store = new InMemoryDistillationStore();
    const batcher = new UsageBatcher(store, { batchSize: 2, flushIntervalMs: 1_000_000 });
    batcher.enqueue(
      buildUsageRecord({
        taskId: "t1",
        scope: "scope-A",
        kind: "L1_extract",
        provider: "p",
        model: "m",
        promptTokens: 1,
        completionTokens: 2,
      })
    );
    batcher.enqueue(
      buildUsageRecord({
        taskId: "t2",
        scope: "scope-A",
        kind: "L1_extract",
        provider: "p",
        model: "m",
        promptTokens: 3,
        completionTokens: 4,
      })
    );
    // batchSize=2 should auto-flush
    const flushed = await batcher.flush();
    assert.equal(flushed, 2);
    const snap = store.snapshot();
    assert.equal(snap.usage.length, 2);
  });

  it("stop() flushes any pending records", async () => {
    const store = new InMemoryDistillationStore();
    const batcher = new UsageBatcher(store, { batchSize: 100, flushIntervalMs: 1_000_000 });
    batcher.enqueue(
      buildUsageRecord({
        taskId: "t1",
        scope: "scope-A",
        kind: "L1_extract",
        provider: "p",
        model: "m",
        promptTokens: 1,
        completionTokens: 1,
      })
    );
    await batcher.stop();
    const snap = store.snapshot();
    assert.equal(snap.usage.length, 1);
  });
});
