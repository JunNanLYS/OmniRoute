import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryDistillationStore } from "../../../../src/memory/distillation/store.ts";
import type { DistillationTask } from "../../../../src/memory/distillation/store.ts";

function makeTask(over: Partial<DistillationTask>): DistillationTask {
  return {
    id: over.id ?? "t1",
    kind: "L1_extract",
    scope: "scope-A",
    payload: { conversation: "hi" },
    priority: 0,
    attempt: 0,
    notBefore: 0,
    status: "queued",
    providerHint: null,
    modelHint: null,
    lastError: null,
    version: 1,
    ...over,
  };
}

describe("distillation/store — claim/transition guards", () => {
  it("claimNextTask returns null when nothing queued", async () => {
    const store = new InMemoryDistillationStore();
    const claim = await store.claimNextTask(Date.now(), null);
    assert.equal(claim.task, null);
  });

  it("claimNextTask respects notBefore", async () => {
    const store = new InMemoryDistillationStore();
    const future = makeTask({ id: "future", notBefore: Date.now() + 60_000 });
    const ready = makeTask({ id: "ready", notBefore: Date.now() - 1000 });
    store.seed([future, ready]);
    const claim = await store.claimNextTask(Date.now(), null);
    assert.equal(claim.task?.id, "ready");
  });

  it("claimNextTask returns the highest priority when multiple are ready", async () => {
    const store = new InMemoryDistillationStore();
    store.seed([
      makeTask({ id: "low", priority: 1 }),
      makeTask({ id: "high", priority: 9 }),
      makeTask({ id: "mid", priority: 5 }),
    ]);
    const claim = await store.claimNextTask(Date.now(), null);
    assert.equal(claim.task?.id, "high");
  });

  it("claimNextTask filters by scope when supplied", async () => {
    const store = new InMemoryDistillationStore();
    store.seed([
      makeTask({ id: "A1", scope: "scope-A" }),
      makeTask({ id: "B1", scope: "scope-B" }),
    ]);
    const claim = await store.claimNextTask(Date.now(), "scope-B");
    assert.equal(claim.task?.id, "B1");
  });

  it("markClaimed is an optimistic transition; rejects stale version", async () => {
    const store = new InMemoryDistillationStore();
    const t = makeTask({ id: "t1", version: 3 });
    store.seed([t]);
    const ok1 = await store.markClaimed("t1", 3, "owner", 60_000);
    assert.equal(ok1, true);
    const ok2 = await store.markClaimed("t1", 3, "owner", 60_000);
    assert.equal(ok2, false);
    const snap = store.snapshot();
    const claimed = snap.tasks.find((x) => x.id === "t1");
    assert.equal(claimed?.status, "claimed");
    assert.equal(claimed?.version, 4);
  });

  it("markRetry bumps attempt and version; resets to queued", async () => {
    const store = new InMemoryDistillationStore();
    store.seed([makeTask({ id: "r", attempt: 1, version: 5 })]);
    await store.markClaimed("r", 5, "o", 1000);
    await store.markRetry("r", "o", 2, Date.now() + 5000, "boom");
    const snap = store.snapshot();
    const r = snap.tasks.find((x) => x.id === "r");
    assert.equal(r?.status, "queued");
    assert.equal(r?.attempt, 2);
    assert.equal(r?.version, 7);
    assert.equal(r?.lastError, "boom");
  });

  it("markSkippedBreaker pushes notBefore and leaves status queued", async () => {
    const store = new InMemoryDistillationStore();
    const start = Date.now();
    store.seed([makeTask({ id: "s" })]);
    await store.markSkippedBreaker("s", "o", start + 30_000, "breaker");
    const t = store.snapshot().tasks.find((x) => x.id === "s");
    assert.equal(t?.status, "queued");
    assert.ok((t?.notBefore ?? 0) > start);
  });

  it("markDLQ transitions to failed_dlq and appends DLQ entry", async () => {
    const store = new InMemoryDistillationStore();
    store.seed([makeTask({ id: "d" })]);
    await store.markDLQ("d", "o", "bad", "no_retry");
    await store.appendDLQ({
      taskId: "d",
      reason: "no_retry",
      failureKind: "no_retry",
      attempts: 0,
      error: "bad",
      recordedAt: Date.now(),
    });
    const snap = store.snapshot();
    assert.equal(snap.tasks[0]?.status, "failed_dlq");
    assert.equal(snap.dlq.length, 1);
    assert.equal(snap.dlq[0]?.failureKind, "no_retry");
  });

  it("acquireLock rejects when a different owner holds it", async () => {
    const store = new InMemoryDistillationStore();
    const a = await store.acquireLock("scope-A", "ownerA", 60_000);
    assert.ok(a);
    const b = await store.acquireLock("scope-A", "ownerB", 60_000);
    assert.equal(b, null);
  });

  it("acquireLock by the same owner renews the lease", async () => {
    const store = new InMemoryDistillationStore();
    const a = await store.acquireLock("scope-A", "ownerA", 60_000);
    assert.ok(a);
    const b = await store.acquireLock("scope-A", "ownerA", 90_000);
    assert.ok(b);
    assert.equal(b?.ownerId, "ownerA");
  });

  it("usage accounting keeps the first record per task", async () => {
    const store = new InMemoryDistillationStore();
    const task = makeTask({ id: "usage-once" });
    store.seed([task]);
    assert.equal(await store.markClaimed(task.id, task.version, "owner", 60_000), true);
    await store.markRunning(task.id, "owner");
    const first = {
      taskId: task.id,
      scope: task.scope,
      kind: task.kind,
      provider: "p1",
      model: "m1",
      tokens: 10,
      usd: 0.001,
      recordedAt: 100,
    };

    await store.completeTask(
      task,
      "owner",
      { payload: { memories: [] }, fallbackEvidence: [] },
      first
    );
    await store.recordUsage({
      ...first,
      provider: "p2",
      model: "m2",
      tokens: 20,
      usd: 0.002,
      recordedAt: 200,
    });

    assert.deepEqual(store.snapshot().usage, [first]);
  });

  it("recordUsage stores a record; getQueueStats counts queued/running/dlq", async () => {
    const store = new InMemoryDistillationStore();
    store.seed([
      makeTask({ id: "q1" }),
      makeTask({ id: "r1", status: "running" }),
      makeTask({ id: "d1", status: "failed_dlq" }),
    ]);
    await store.recordUsage({
      taskId: "q1",
      scope: "scope-A",
      kind: "L1_extract",
      provider: "p",
      model: "m",
      tokens: 100,
      usd: 0.001,
      recordedAt: Date.now(),
    });
    const stats = await store.getQueueStats();
    assert.equal(stats.queued, 1);
    assert.equal(stats.running, 1);
    assert.equal(stats.dlq, 0);
  });
});
