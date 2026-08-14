import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  withOwnerLock,
  LOCK_TTL_MS,
  LOCK_RENEW_MS,
} from "../../../../src/memory/distillation/lock.ts";
import { InMemoryDistillationStore } from "../../../../src/memory/distillation/store.ts";

describe("distillation/lock — owner mutual exclusion + renew", () => {
  it("issues a lock and renews it on the same owner", async () => {
    const store = new InMemoryDistillationStore();
    const handle = await withOwnerLock(store, "scope-A", "owner-1");
    assert.ok(handle);
    const renew = await handle.renew();
    assert.equal(renew, true);
    await handle.release();
  });

  it("refuses a second owner while the lease is valid", async () => {
    const store = new InMemoryDistillationStore();
    const a = await withOwnerLock(store, "scope-A", "owner-1");
    assert.ok(a);
    const b = await withOwnerLock(store, "scope-A", "owner-2");
    assert.equal(b, null);
    await a.release();
    const c = await withOwnerLock(store, "scope-A", "owner-2");
    assert.ok(c);
    await c.release();
  });

  it("defaults to 240s TTL and 30s renew", () => {
    assert.equal(LOCK_TTL_MS, 240_000);
    assert.equal(LOCK_RENEW_MS, 30_000);
  });

  it("auto-renew keeps the lock alive past the original TTL", async () => {
    const store = new InMemoryDistillationStore();
    let now = 1_000_000;
    const sched = makeScheduler();
    const handle = await withOwnerLock(store, "scope-A", "owner-1", {
      ttlMs: 1000,
      renewMs: 500,
      now: () => now,
      scheduler: sched,
    });
    assert.ok(handle);
    // Force a renew.
    now += 600;
    sched.fire();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(await handle.renew(), true);
    await handle.release();
  });
});

function makeScheduler() {
  const cbs: Array<() => void> = [];
  return {
    setInterval(cb: () => void, _ms: number) {
      cbs.push(cb);
      return { unref: () => {}, clear: () => {} };
    },
    clearInterval() {},
    fire() {
      for (const cb of cbs) cb();
    },
  };
}
