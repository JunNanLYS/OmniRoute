/**
 * Distillation usage accounting — interface + sanitizing helpers.
 *
 * The worker records tokens and USD separately so the operator's spend
 * dashboard can split distillation from user-facing traffic. The interface
 * is intentionally narrow: the storage layer (the repository owner) just
 * needs an `appendUsage(record)` call.
 *
 * The worker keeps an in-process debounce: it batches usage records and
 * flushes them either every `flushIntervalMs` or when `pending >= batchSize`.
 * Records are NEVER dropped on shutdown — best-effort flush is part of
 * `stopDistillationWorker`.
 */

import type { DistillationStore, DistillationUsageRecord } from "./store.ts";

export interface UsageBatcherOptions {
  /** Max records per flush. Default 32. */
  batchSize?: number;
  /** Time-based flush. Default 5_000 ms. */
  flushIntervalMs?: number;
  /** Override clock + scheduler (tests only). */
  now?: () => number;
  scheduler?: IntervalScheduler;
}

export interface IntervalScheduler {
  setInterval(cb: () => void, ms: number): { unref?: () => void; clear: () => void };
  clearInterval(handle: { unref?: () => void; clear: () => void }): void;
}

const defaultScheduler: IntervalScheduler = {
  setInterval(cb, ms) {
    const id = setInterval(cb, ms);
    return {
      unref: typeof id.unref === "function" ? () => id.unref() : undefined,
      clear: () => clearInterval(id),
    };
  },
  clearInterval(handle) {
    handle.clear();
  },
};

export class UsageBatcher {
  private readonly store: DistillationStore;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly now: () => number;
  private readonly sched: IntervalScheduler;
  private pending: DistillationUsageRecord[] = [];
  private timer: ReturnType<IntervalScheduler["setInterval"]> | null = null;
  private flushInFlight: Promise<number> | null = null;

  constructor(store: DistillationStore, options: UsageBatcherOptions = {}) {
    this.store = store;
    this.batchSize = options.batchSize ?? 32;
    this.flushIntervalMs = options.flushIntervalMs ?? 5_000;
    this.now = options.now ?? Date.now;
    this.sched = options.scheduler ?? defaultScheduler;
  }

  start(): void {
    if (this.timer) return;
    this.timer = this.sched.setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  enqueue(record: DistillationUsageRecord): void {
    // Normalize once at the boundary.
    this.pending.push({
      taskId: String(record.taskId).slice(0, 128),
      scope: String(record.scope).slice(0, 128),
      kind: record.kind,
      provider: String(record.provider).slice(0, 64),
      model: String(record.model).slice(0, 128),
      tokens: Math.max(0, Math.floor(Number(record.tokens) || 0)),
      usd: Math.max(0, Number(record.usd) || 0),
      recordedAt: Number(record.recordedAt) || this.now(),
    });
    if (this.pending.length >= this.batchSize) {
      void this.flush();
    }
  }

  async flush(): Promise<number> {
    // Auto-flush and explicit flush may race. Join the active batch instead of
    // reporting 0 while the store write is still in progress.
    if (this.flushInFlight) return this.flushInFlight;
    if (this.pending.length === 0) return 0;
    const drained = this.pending;
    this.pending = [];
    const run = (async () => {
      for (const record of drained) {
        try {
          await this.store.recordUsage(record);
        } catch {
          // Re-queue at the head so a transient store failure does not lose data.
          this.pending.unshift(record);
        }
      }
      return drained.length;
    })();
    this.flushInFlight = run;
    try {
      return await run;
    } finally {
      if (this.flushInFlight === run) this.flushInFlight = null;
    }
  }

  async stop(): Promise<number> {
    if (this.timer) {
      this.sched.clearInterval(this.timer);
      this.timer = null;
    }
    let flushed = 0;
    if (this.flushInFlight) flushed += await this.flushInFlight;
    flushed += await this.flush();
    return flushed;
  }

  /** Test-only. */
  pendingCount(): number {
    return this.pending.length;
  }
}

/** Convert raw token counts + pricing into a usage record. */
export function buildUsageRecord(args: {
  taskId: string;
  scope: string;
  kind: DistillationUsageRecord["kind"];
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costPerKTokenIn?: number;
  costPerKTokenOut?: number;
  now?: number;
}): DistillationUsageRecord {
  const promptTokens = Math.max(0, Math.floor(args.promptTokens || 0));
  const completionTokens = Math.max(0, Math.floor(args.completionTokens || 0));
  const tokens = promptTokens + completionTokens;
  const inCost =
    typeof args.costPerKTokenIn === "number" ? (promptTokens / 1000) * args.costPerKTokenIn : 0;
  const outCost =
    typeof args.costPerKTokenOut === "number"
      ? (completionTokens / 1000) * args.costPerKTokenOut
      : 0;
  const usd = Math.max(0, inCost + outCost);
  return {
    taskId: args.taskId,
    scope: args.scope,
    kind: args.kind,
    provider: args.provider,
    model: args.model,
    tokens,
    usd,
    recordedAt: args.now ?? Date.now(),
  };
}
