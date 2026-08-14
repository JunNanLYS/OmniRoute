/**
 * ProcessPermitPool — nonblocking concurrency control for distillation tasks.
 *
 * Why: distillation calls a provider LLM in-process (no per-call OS-level
 * resource like a file descriptor), so a permit leak would silently let the
 * worker chew through CPU/network unbounded. The pool is therefore:
 *
 *   - Bounded by `size` (default `MEMORY_DISTILLATION_CONCURRENCY=3`).
 *   - Acquired nonblockingly; over-budget `tryAcquire` returns `false` and
 *     the worker simply leaves the task queued for the next tick.
 *   - TTL-guarded — every acquired permit has an `expiresAt`. The pool
 *     auto-releases expired permits on every read so a stalled task
 *     (hung executor, lost lease, etc) cannot leak capacity past its TTL.
 *
 * The pool is intentionally synchronous (no I/O) so `tryAcquire` is O(1)
 * and the worker loop stays cheap. `now()` is injectable for tests.
 */

export interface AcquiredPermit {
  /** Monotonic id; useful in logs. */
  readonly id: number;
  /** Pool that issued this permit. Always release back to THIS pool. */
  readonly pool: ProcessPermitPool;
  /** Epoch ms when the permit auto-releases. */
  readonly expiresAt: number;
  /** Original TTL the caller asked for. */
  readonly ttlMs: number;
}

export interface PermitPoolOptions {
  size: number;
  ttlMs?: number;
  /** Override the clock (tests only). */
  now?: () => number;
}

let permitCounter = 0;

export class ProcessPermitPool {
  private readonly _size: number;
  private readonly _ttlMs: number;
  private readonly _now: () => number;
  /** id → issuedAt; expired entries are pruned lazily. */
  private readonly live = new Map<number, number>();

  constructor(options: PermitPoolOptions) {
    if (!Number.isFinite(options.size) || options.size < 1) {
      throw new Error("ProcessPermitPool: size must be >= 1");
    }
    this._size = Math.floor(options.size);
    this._ttlMs = options.ttlMs ?? 60_000;
    this._now = options.now ?? Date.now;
  }

  /** Total slots. Never changes after construction. */
  get size(): number {
    return this._size;
  }

  /** Number of slots currently held (after pruning expired permits). */
  inUse(): number {
    this.prune();
    return this.live.size;
  }

  /**
   * Try to acquire a permit without blocking. Returns `null` when at capacity.
   * The permit MUST be released via `permit.release()` (or by its TTL).
   */
  tryAcquire(): AcquiredPermit | null {
    this.prune();
    if (this.live.size >= this._size) return null;
    const id = ++permitCounter;
    const issuedAt = this._now();
    this.live.set(id, issuedAt);
    return {
      id,
      pool: this,
      ttlMs: this._ttlMs,
      expiresAt: issuedAt + this._ttlMs,
    };
  }

  /** Release a permit. Idempotent. */
  release(permit: AcquiredPermit): void {
    if (permit.pool !== this) return;
    this.live.delete(permit.id);
  }

  /**
   * Drop every permit regardless of TTL — only intended for the test reset
   * hook and for shutdown. Caller is responsible for cancelling the
   * in-flight work too.
   */
  clear(): void {
    this.live.clear();
  }

  /** Sweep expired permits. Returns the count dropped. */
  prune(now: number = this._now()): number {
    let dropped = 0;
    for (const [id, issuedAt] of this.live) {
      if (now - issuedAt >= this._ttlMs) {
        this.live.delete(id);
        dropped++;
      }
    }
    return dropped;
  }
}

/** Convenience: release a permit without throwing when null. */
export function releasePermit(permit: AcquiredPermit | null): void {
  if (permit) permit.pool.release(permit);
}
