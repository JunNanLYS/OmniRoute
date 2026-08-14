/**
 * Four-layer Memory API Zod schemas.
 *
 * Schemas for the new `/api/memory/l0..l3`, `/api/memory/distillation-model`,
 * and `/api/memory/distillation-model/dlq` routes. The legacy `engine-status`,
 * `health`, `reindex`, `retrieve-preview`, and `summarize` routes are deleted
 * and the new layers replace them.
 *
 * Conventions:
 *  - All input schemas are `.strict()` (reject unknown fields).
 *  - Owner/identity is derived from the auth subject (Never from query/body).
 *  - All schemas return 400 on failure via `validatedJsonBody`.
 *  - Pagination, owner filters, lineage filters, and "include deleted / recycle"
 *    are common query knobs and exposed as helpers (`memoryListingQuery`).
 */
import { z } from "zod";

/**
 * 7 L1 memory types. The legacy engine exposed only 4 (`factual`, `episodic`,
 * `procedural`, `semantic`). The four-layer model adds 3 more for the curated
 * owner-managed memory slots.
 */
export const L1_TYPE_VALUES = [
  "persona",
  "episodic",
  "instruction",
  "work_fact",
  "work_task",
  "work_method",
  "work_artifact",
] as const;

export const L1TypeSchema = z.enum(L1_TYPE_VALUES);

/**
 * Soft-delete and restore scopes. `_RECYCLE` is the explicit
 * "include deleted" listing flag.
 */
export const MemoryRecycleScopeSchema = z.enum(["active", "deleted", "any"]).default("active");

/**
 * Common listing query — pagination, owner filter, lineage filter, recycle.
 * Reused by L0/L1/L2/L3 list endpoints.
 */
export const memoryListingQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).optional(),
    apiKeyId: z.string().optional(),
    sessionId: z.string().optional(),
    sceneName: z.string().optional(),
    sourceId: z.string().optional(),
    type: L1TypeSchema.optional(),
    q: z.string().optional(),
    includeDeleted: MemoryRecycleScopeSchema.optional(),
  })
  .strict();

export type MemoryListingQuery = z.infer<typeof memoryListingQuerySchema>;

/**
 * L0 lineage items are immutable, owner-bound, append-only by the engine.
 * L0 is the raw trace (`chat`/`agent`/`tool` events).
 *
 * Hard rule: L0 has NO PUT. POST only admits `/import` (admin/owner bulk).
 */
export const L0ImportSchema = z
  .object({
    sessionId: z.string().min(1),
    items: z
      .array(
        z
          .object({
            idempotencyKey: z.string().min(1).max(256),
            role: z.enum(["user", "assistant"]),
            content: z.string().min(1),
            timestamp: z.coerce.date().optional(),
            correlationId: z.string().optional(),
            provider: z.string().optional(),
            model: z.string().optional(),
          })
          .strict()
      )
      .min(1)
      .max(500),
  })
  .strict();

export const L0DeleteBodySchema = z
  .object({
    mode: z.enum(["soft", "permanent"]).default("soft"),
    sessionId: z.string().optional(),
  })
  .strict();

export const L0DeleteAllSchema = z
  .object({
    sessionId: z.string().min(1),
    mode: z.enum(["soft", "permanent"]).default("soft"),
  })
  .strict();

export type L0Import = z.infer<typeof L0ImportSchema>;
export type L0DeleteBody = z.infer<typeof L0DeleteBodySchema>;
export type L0DeleteAll = z.infer<typeof L0DeleteAllSchema>;

/**
 * L1 — owner-curated memories. 7 types, priority 0..100, edit with optimistic
 * version, audit on every write.
 */
export const L1CreateSchema = z
  .object({
    type: L1TypeSchema,
    priority: z.number().int().min(0).max(100).default(50),
    content: z.string().min(1),
    sceneName: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).default({}),
    sourceMessageIds: z.array(z.string().min(1)).max(500).default([]),
  })
  .strict();

export const L1UpdateSchema = z
  .object({
    priority: z.number().int().min(0).max(100).optional(),
    content: z.string().min(1).optional(),
    sceneName: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    sourceMessageIds: z.array(z.string().min(1)).max(500).optional(),
    expectedVersion: z.number().int().min(1),
  })
  .strict();

export const L1DeleteBodySchema = z
  .object({
    mode: z.enum(["soft", "permanent"]).default("soft"),
  })
  .strict();

export type L1Create = z.infer<typeof L1CreateSchema>;
export type L1Update = z.infer<typeof L1UpdateSchema>;
export type L1DeleteBody = z.infer<typeof L1DeleteBodySchema>;

/**
 * L2 — derived/working memory. Module-internal only. Each L3 may distill
 * from one L2.
 */
export const L2CreateSchema = z
  .object({
    sceneName: z.string().min(1),
    groupKey: z.string().nullable().optional(),
    summary: z.string(),
    heat: z.number().min(0).max(1),
    content: z.string().min(1),
  })
  .strict();

export const L2UpdateSchema = z
  .object({
    sceneName: z.string().min(1).optional(),
    groupKey: z.string().nullable().optional(),
    summary: z.string().optional(),
    heat: z.number().min(0).max(1).optional(),
    content: z.string().min(1).optional(),
    expectedVersion: z.number().int().min(1),
  })
  .strict();

export const L2DeleteBodySchema = z
  .object({
    mode: z.enum(["soft", "permanent"]).default("soft"),
  })
  .strict();

/** Regenerate body — enqueue a task. 409 if >15 errors within the rolling window. */
export const L2RegenerateSchema = z
  .object({
    reason: z.string().max(200).optional(),
  })
  .strict()
  .default({});

export type L2Create = z.infer<typeof L2CreateSchema>;
export type L2Update = z.infer<typeof L2UpdateSchema>;
export type L2DeleteBody = z.infer<typeof L2DeleteBodySchema>;
export type L2Regenerate = z.infer<typeof L2RegenerateSchema>;

/**
 * L3 — the operator-visible distilled memory. Upsertable.
 */
export const L3UpsertSchema = z
  .object({
    content: z.string().min(1),
    promptMode: z.enum(["chat", "code"]),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict();

export const L3DeleteBodySchema = z
  .object({
    mode: z.enum(["soft", "restore", "permanent"]).default("soft"),
  })
  .strict();

/** Same regenerate contract as L2 */
export const L3RegenerateSchema = z
  .object({
    reason: z.string().max(200).optional(),
  })
  .strict()
  .default({});

export type L3Upsert = z.infer<typeof L3UpsertSchema>;
export type L3DeleteBody = z.infer<typeof L3DeleteBodySchema>;
export type L3Regenerate = z.infer<typeof L3RegenerateSchema>;

/**
 * Distillation-model — the LLM selector. Resolution order (first hit wins):
 *
 *   1. per-key (apiKeyId) explicit record
 *   2. global record
 *   3. env (DISTILLATION_MODEL / DISTILLATION_PROVIDER_MODEL)
 *   4. auto (provider default + first synced available model)
 *
 * `sourceLayer` tells the caller which rung of the ladder supplied the
 * effective value.
 */
export const DistillationScopeSchema = z.enum(["self", "global"]);

export const DistillationPutSchema = z
  .object({
    provider: z.string().min(1),
    modelId: z.string().min(1),
    scope: DistillationScopeSchema,
    apiKeyId: z.string().min(1).optional(),
  })
  .strict();

export type DistillationPut = z.infer<typeof DistillationPutSchema>;

/**
 * Distillation DLQ — a record of failed distillation tasks. `POST /retry`
 * enqueues selected or all failed records.
 */
export const DistillationDlqRetrySchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(500).optional(),
    all: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Boolean(v.ids?.length) || v.all === true, {
    message: "Either 'ids' or 'all' must be provided",
    path: ["ids"],
  });

export type DistillationDlqRetry = z.infer<typeof DistillationDlqRetrySchema>;
