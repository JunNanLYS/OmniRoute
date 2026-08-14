/**
 * Owner-level lock helpers.
 *
 * The actual store calls live in `DistillationStore.acquireLock` /
 * `releaseLock`. This module is the pure scheduling + renewal layer the
 * worker uses on top of those primitives:
 *
 *   - A lock TTL of `LOCK_TTL_MS` (default 240 s) prevents a dead process
 *     from holding the queue forever.
 *   - The worker renews every `LOCK_RENEW_MS` (default 30 s) so a long
 *     batch of tasks cannot be evicted mid-flight by the TTL.
 *   - `withOwnerLock` returns a small handle that the worker can use to
 *     cancel the renewer on shutdown.
 *
 * The lock is per-scope (apiKeyId / global) so two scopes can be
 * distilled concurrently — only the same scope is serialized.
 */

import type { DistillationLock, DistillationStore } from "./store.ts";

export const LOCK_TTL_MS = 240_000;
export const LOCK_RENEW_MS = 30_000;

export interface OwnerLockHandle {
  scope: string;
  ownerId: string;
  /** Cancel the renewer. Idempotent. */
  cancel: () => void;
  /** Renew now; returns true when the lock is still owned after the call. */
  renew: () => Promise<boolean>;
  /** Release + cancel. */
  release: () => Promise<void>;
}

export interface OwnerLockOptions {
  ttlMs?: number;
  renewMs?: number;
  /** Override clock (tests only). */
  now?: () => number;
  /** Override setInterval/clearTimeout (tests only). */
  scheduler?: IntervalScheduler;
}

export interface IntervalScheduler {
  setInterval(cb: () => void, ms: number): { unref?: () => void; clear: () => void };
  clearInterval(handle: { unref?: () => void; clear: () => void }): void;
}

const defaultScheduler: IntervalScheduler = {
  setInterval(cb, ms) {
    const id = setInterval(cb, ms);
    const handle = {
      unref: typeof id.unref === "function" ? () => id.unref() : undefined,
      clear: () => clearInterval(id),
    };
    return handle;
  },
  clearInterval(handle) {
    handle.clear();
  },
};

/**
 * Acquire the lock for `scope` and start an auto-renew loop. Returns
 * `null` when another process holds it AND the lease is still valid — the
 * caller decides whether to skip or wait.
 */
export async function withOwnerLock(
  store: DistillationStore,
  scope: string,
  ownerId: string,
  options: OwnerLockOptions = {}
): Promise<OwnerLockHandle | null> {
  const ttl = options.ttlMs ?? LOCK_TTL_MS;
  const renewMs = options.renewMs ?? LOCK_RENEW_MS;
  const sched = options.scheduler ?? defaultScheduler;
  const lock = await store.acquireLock(scope, ownerId, ttl);
  if (!lock) return null;
  let cancelled = false;
  let timer: ReturnType<IntervalScheduler["setInterval"]> | null = null;
  const renew = async () => {
    if (cancelled) return false;
    const next = await store.acquireLock(scope, ownerId, ttl);
    if (!next) return false;
    return true;
  };
  const release = async () => {
    if (cancelled) return;
    cancelled = true;
    if (timer) {
      sched.clearInterval(timer);
      timer = null;
    }
    await store.releaseLock(scope, ownerId);
  };
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    if (timer) {
      sched.clearInterval(timer);
      timer = null;
    }
  };
  timer = sched.setInterval(() => {
    void renew();
  }, renewMs);
  timer.unref?.();
  return { scope, ownerId, cancel, renew, release };
}

export function isLockStillValid(lock: DistillationLock, now: number = Date.now()): boolean {
  return lock.expiresAt > now;
}
