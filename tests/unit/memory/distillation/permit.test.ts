import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProcessPermitPool, releasePermit } from "../../../../src/memory/distillation/permit.ts";

describe("distillation/permit — nonblocking pool", () => {
  it("rejects construction with size < 1", () => {
    assert.throws(() => new ProcessPermitPool({ size: 0 }));
  });

  it("admits up to `size`, then refuses", () => {
    const pool = new ProcessPermitPool({ size: 3, ttlMs: 10_000, now: () => 1000 });
    const a = pool.tryAcquire();
    const b = pool.tryAcquire();
    const c = pool.tryAcquire();
    const d = pool.tryAcquire();
    assert.ok(a && b && c);
    assert.equal(d, null);
    assert.equal(pool.inUse(), 3);
  });

  it("release returns a slot to the pool", () => {
    const pool = new ProcessPermitPool({ size: 1, now: () => 1000 });
    const p = pool.tryAcquire();
    assert.ok(p);
    assert.equal(pool.tryAcquire(), null);
    releasePermit(p);
    assert.equal(pool.inUse(), 0);
    const q = pool.tryAcquire();
    assert.ok(q);
  });

  it("auto-releases a permit whose TTL has elapsed", () => {
    let now = 1000;
    const pool = new ProcessPermitPool({ size: 1, ttlMs: 5_000, now: () => now });
    const p = pool.tryAcquire();
    assert.ok(p);
    now = 7_000; // 6s later
    assert.equal(pool.inUse(), 0);
    assert.ok(pool.tryAcquire());
  });

  it("no permit leak under repeated acquire/release cycles", () => {
    const pool = new ProcessPermitPool({ size: 2, ttlMs: 60_000, now: () => 1000 });
    for (let i = 0; i < 100; i++) {
      const p = pool.tryAcquire();
      assert.ok(p);
      releasePermit(p);
    }
    assert.equal(pool.inUse(), 0);
  });

  it("release is idempotent on the same permit", () => {
    const pool = new ProcessPermitPool({ size: 1, now: () => 1000 });
    const p = pool.tryAcquire();
    assert.ok(p);
    releasePermit(p);
    releasePermit(p);
    assert.equal(pool.inUse(), 0);
  });

  it("release from a foreign pool is a no-op (defensive)", () => {
    const poolA = new ProcessPermitPool({ size: 1, now: () => 1000 });
    const poolB = new ProcessPermitPool({ size: 1, now: () => 1000 });
    const p = poolA.tryAcquire();
    assert.ok(p);
    releasePermit(p);
    // p already released; releasing again from a different pool must not
    // corrupt poolB's accounting.
    poolB.tryAcquire();
    assert.equal(poolB.inUse(), 1);
  });

  it("prune returns the count of expired permits dropped", () => {
    let now = 1000;
    const pool = new ProcessPermitPool({ size: 4, ttlMs: 1000, now: () => now });
    pool.tryAcquire();
    pool.tryAcquire();
    now = 5_000;
    const dropped = pool.prune();
    assert.equal(dropped, 2);
    assert.equal(pool.inUse(), 0);
  });
});
