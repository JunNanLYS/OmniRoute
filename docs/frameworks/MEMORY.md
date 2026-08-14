---
title: "Memory System"
version: 4.0.0
lastUpdated: 2026-08-13
---

# Memory System

> **Source of truth:** `src/memory/` (runtime), `src/app/api/memory/` (REST), and the
> chat-pipeline seams in `open-sse/handlers/chatCore/`.
> **Last updated:** 2026-08-13 — **v4.0.0 four-layer hard cutover** (L0 raw trace, L1 owner-curated memories, L2 derived scenes, L3 distilled persona; SQLite `memory.db` standalone; no Qdrant; no external vector store).

The four-layer Memory System replaces the v3.x single-table conversational memory with a strictly-typed pipeline. **This is a breaking replacement of the v3.x memory architecture** — there is no migration shim: the v3 `src/lib/memory/` modules, `memoryVec.ts`, the Qdrant settings routes, and the legacy `memories`/`vec_memories` access paths are all removed. The four-layer runtime reads and writes only the standalone `<DATA_DIR>/memory.db`.

> **Fork-only publication.** This four-layer architecture is a fork-specific design — it is **not** an upstream contribution. The upstream OmniRoute memory subsystem (`src/lib/memory/`) keeps the v3.x single-table design. License attribution for the v3.x-derived storage helpers remains in the project `THIRD-PARTY-NOTICES` file and is managed by the license attribution agent (no per-doc attribution added here).

## Why four layers

A single flat memory table mixes three concerns: full-fidelity transcripts (huge, useful for replay), distilled long-term facts (small, useful for retrieval), and "where am I in the conversation" navigation (stateful, per-request). The four-layer split lets each layer pick the right storage shape and lifecycle:

| Layer  | Purpose                                                                     | Cardinality                                    | Storage                   | Lifecycle                                                    |
| ------ | --------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------- | ------------------------------------------------------------ |
| **L0** | Raw session trace — full visible text per turn, kept verbatim               | Per turn, all turns                            | SQLite `memory.db`        | Append-only; soft/permanent delete per record or per session |
| **L1** | Owner-curated memories — 7 typed categories with priority and scene         | Per record, deduped per owner                  | SQLite `memory.db` + FTS5 | Optimistic-version edits; soft/permanent delete; recycle     |
| **L2** | Derived/working scenes — summaries + heat, grouped per conversation region  | ≤15 active per owner                           | SQLite `memory.db`        | Upsert with merge-heat; regeneration tasks; soft delete      |
| **L3** | Distilled persona — the operator-visible working memory (chat vs code mode) | 1 per owner (mutually exclusive `chat`/`code`) | SQLite `memory.db`        | Upsert with `expectedVersion`; `restore` mode; regenerate    |

The 7 L1 types are: `persona`, `episodic`, `instruction`, `work_fact`, `work_task`, `work_method`, `work_artifact`. (See [L1 Types](#l1-types) below.)

> **No external vector store.** Unlike v3.x, this architecture does not load sqlite-vec as a hard dependency and does not support Qdrant, Redis, an SDK vector cache, or any AI SDK. FTS5 is the authoritative retrieval surface; the optional sqlite-vec path (`src/memory/vectorStore.ts`) is best-effort, disabled with `VECTOR_STORE_DISABLE_VEC=true`, and callers must fall back to FTS5 when it is unavailable.

## Storage: standalone `memory.db`

Memory state lives in a **dedicated SQLite database file**, not in the main OmniRoute DB. The path is `<DATA_DIR>/memory.db`. The database is opened in WAL mode by `src/memory/db/core.ts` (`getMemoryDbInstance()`), and schema migrations live in `src/memory/db/migrations/` (`001_memory_l0_initial.sql` … `009_distillation_usage_idempotency.sql`). Storage repositories live in `src/memory/db/repositories/`; all access goes through the four-layer service (`src/memory/db/service.ts`) — no raw SQL outside `src/memory/db/`.

- **No backup.** `memory.db` is not backed up by OmniRoute's snapshot tooling. Operators must arrange their own off-host backup if they need it.
- **No shared DB.** `memory.db` is opened exclusively by `src/memory/db/core.ts`; no other domain module touches it.
- **No Redis.** Capture and injection paths do not consult or write any Redis or external cache. There is no `ai`-SDK or `@ai-sdk/*` dependency in the memory subsystem.
- **Deletion is per-record, not per-file.** There is no endpoint that deletes `memory.db`. Delete endpoints accept `mode: "soft" | "permanent"` (L3 also accepts `"restore"`).

```
DATA_DIR/
├── omniroute.db          # main app DB (unchanged)
├── memory.db             # standalone memory DB (L0/L1/L2/L3 + FTS5 + optional vec)
├── memory.db-wal         # WAL journal (auto-managed)
└── memory.db-shm         # shared memory file (auto-managed)
```

## Capture & injection (opt-in, per API key)

Memory capture and injection are **off by default**. The pipeline settings shape (`src/memory/integration/settings.ts`) carries two independent switches:

- `captureEnabled` — when `true`, the last user + assistant visible text per turn is written to L0 (async, never blocks the response).
- `injectionEnabled` — when `true`, the chat pipeline injects L3 (cacheable system suffix) + L2 (navigation) + L1 (dynamic top-5) before the final user prompt.

Both default to `false`. The default resolver reads only two env vars — `OMNIROUTE_MEMORY_CAPTURE_ENABLED` and `OMNIROUTE_MEMORY_INJECTION_ENABLED` — with strict parsing (`true`/`1`/`yes` enable; anything else, including the removed v3 `MEMORY_ENABLED` and its aliases, is ignored). A future per-owner settings store can replace the resolver via the `setMemoryPipelineSettingsResolver()` seam; the recall provider is swappable via `setRecallProvider()`.

### PII flags

PII redaction flags are **unchanged** — still `PII_REDACTION_ENABLED` (request-side) and `PII_RESPONSE_SANITIZATION` (response-side), both default `false` per Hard Rule #20. Memory capture does **not** re-enable PII mutation by default; the existing `src/lib/guardrails/piiMasker.ts` and `src/lib/streamingPiiTransform.ts` paths are unchanged. Operators who want memory capture to redact PII before writing to L0 must enable `PII_REDACTION_ENABLED` separately.

### No-memory header (per-request opt-out)

A client can opt a single request out with the `x-omniroute-no-memory` header (`true`/`1`/`yes`). The check is performed in `open-sse/handlers/chatCore/headers.ts::isNoMemoryRequested` — when set, both capture and injection are skipped for that request. This header is **always honoured**, regardless of per-key or global defaults.

### Internal marker (no-memory propagation)

When a request is a sub-call within the memory subsystem itself (e.g. a background distillation pass calling an LLM, or a self-generated tool call that shouldn't recursively inject memory), the chat pipeline stamps an **HMAC-signed internal marker** on the outbound upstream call. The marker is produced by `src/memory/distillation/internalMarker.ts` (`signInternalMarker`), consumed by `chatCore.ts`, and prevents a second capture pass from running on distillation output. The marker is **not** visible to operators; it is independent of the `x-omniroute-no-memory` header (the header is operator-facing; the marker is internal).

## Distillation (background)

L1 memories and L2 scenes are produced by a **background distillation worker** that scans L0 turns and writes new L1/L2 rows, and periodically distills L3 personas. The worker runs out-of-band; the chat pipeline never waits for it. Worker lifecycle lives in `src/memory/distillation/` (worker, scheduler, permit, executor, selector) and `src/memory/integration/distillationRuntime.ts`.

The worker is **doubly opt-in**: `MEMORY_DISTILLATION_ENABLED=true` AND a positive `MEMORY_DISTILLATION_INTERVAL` (seconds, default 60). Concurrency is bounded by `MEMORY_DISTILLATION_CONCURRENCY` (default 3). Tasks are persisted in `task_queue` with kinds `L0_chunk_embed`, `L1_extract`, `L2_scene`, `L3_persona` and statuses `queued` → `claimed` → `running` → `succeeded` | `failed_retry` | `failed_dlq`. Task idempotency keys (`idempotency_key`) prevent duplicate enqueues; L1 `pipeline_key` makes pipeline application exactly-once; distillation usage is billed at most once per task.

The distillation model selector chain (`src/memory/distillation/selector.ts`, first hit wins):

1. Per-task hint (`providerHint` / `modelHint`) — locked by the caller, never switched mid-run.
2. Per-key selector record (`scope: "self"`).
3. Global selector record (`scope: "global"`).
4. `MEMORY_DISTILLATION_MODEL` env override (`provider/model`).
5. First active configured provider × first synced model.

If none resolves, the task fails with `model_unset` — there is **no silent fallback**. Failed tasks land in the DLQ; retries are manual via `POST /api/memory/distillation-model/dlq` (`{ ids: [...] }` or `{ all: true }`). L2/L3 regeneration enqueues a task (`POST /api/memory/l2/{id}/regenerate`); the service rejects with `409` when more than 15 errors occurred in the rolling window.

## Injection: L3 + L2 + L1 (budgeted, non-blocking)

When `injectionEnabled=true` and the request is not a no-memory request, the chat pipeline injects, in order:

1. **L3 persona** — the cacheable system suffix (the distilled working memory: content + `promptMode` `chat`|`code`).
2. **L2 navigation** — the active scenes (sceneName/summary/heat) for the owner.
3. **L1 dynamic top-5** — the highest-scoring memories matching the current query, placed **before the final user prompt**.

**L0 is never auto-injected** — raw traces are excluded from recall and injection; tools that need raw history read the L0 collection explicitly.

### Caps and timeout

All budgets come from the pipeline settings (`src/memory/integration/settings.ts`) and are clamped by `normalizePipelineSettings`:

- `l3CharBudget` / `l2CharBudget` / `l1CharBudget` — hard per-layer character budgets (default 600 each, clamp 0–64000).
- `totalCharBudget` — total injected characters (default 8000, clamp 0–64000).
- `recallTimeoutMs` — dynamic L1 retrieval timeout (default 5000, clamp 1–60000).

Recall failures **must NOT block the pipeline** — on timeout or error the request proceeds without memory. There is no `MEMORY_INJECT_MAX_TOKENS`-style env knob; budgets are resolver-driven.

The injection always happens **before** compression (per v3.x behaviour). When a request also enables `COMPRESSION_PIPELINE_BREAKER_ENABLED`, the breaker does **not** consider memory payload as the "input" to compress — compression runs on the user-supplied content only.

## Architecture

```
Client → /v1/chat/completions
  → chatCore.ts
    → resolveMemoryOwnerId(apiKeyInfo)          # memoryExtraction.ts
    → isNoMemoryRequested(headers)               # x-omniroute-no-memory + internal marker
    → if enabled and not no-memory:
        → resolveMemoryPipelineSettings(apiKeyId)     # capture/injection + budgets
        → injection: L3 suffix + L2 scenes + L1 dynamic top-5 (budgeted, ≤recallTimeoutMs)
    → upstream provider call
    → on response (async, non-blocking):
        → if captureEnabled and not no-memory and not internal-marker:
            → L0 capture: last user + assistant visible text (idempotent per turn)
        → distillation queue tick (worker-driven, doubly opt-in env switches)
```

## REST API

All routes derive the owner from the auth subject: a dashboard session (management) or a bearer API key (self). **Self callers cannot cross owners** — a mismatched `?apiKeyId=` returns 403. Management callers may select `?apiKeyId=...` to scope to any key. Anonymous requests get 401. Every error response routes through `buildErrorBody()` / `sanitizeErrorMessage()` per Hard Rule #12.

### Four-layer CRUD

| Method                      | Path                             | Description                                                                                                                                                                    |
| --------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`                       | `/api/memory/l0`                 | List raw L0 turns — `?q=`, `?sessionId=`, `?sceneName=`, `?sourceId=`, `?type=`, `?page=&limit=&offset=`, `?includeDeleted=`. Returns `{ data, pagination }`.                  |
| `POST`                      | `/api/memory/l0`                 | Bulk import — body: `{ sessionId, items: [{ idempotencyKey, role, content, timestamp?, correlationId?, provider?, model? }] }` (1–500 items). Idempotent per `idempotencyKey`. |
| `POST`                      | `/api/memory/l0?sessionId=...`   | Delete an entire session — body: `{ sessionId, mode: "soft"\|"permanent" }`.                                                                                                   |
| `GET`/`DELETE`/`POST`       | `/api/memory/l0/{id}`            | Read / soft-or-permanent delete / recycle a single L0 turn.                                                                                                                    |
| `GET`                       | `/api/memory/l1`                 | List L1 memories — same listing query as L0 plus `?type=` (one of the 7 types). With `?q=` routes through `searchL1()` (FTS5).                                                 |
| `POST`                      | `/api/memory/l1`                 | Create — body: `{ type, content, sceneName, priority? (0–100, default 50), metadata?, sourceMessageIds? }`.                                                                    |
| `GET`/`PUT`/`DELETE`/`POST` | `/api/memory/l1/{id}`            | Read / update (optimistic `expectedVersion` required; 409 on conflict) / soft-or-permanent delete / recycle.                                                                   |
| `GET`                       | `/api/memory/l2`                 | List L2 scenes — same listing query. ≤15 active per owner.                                                                                                                     |
| `POST`                      | `/api/memory/l2`                 | Create — body: `{ sceneName, summary, heat (0–1), content, groupKey? }`.                                                                                                       |
| `GET`/`PUT`/`DELETE`/`POST` | `/api/memory/l2/{id}`            | Read / update (optimistic `expectedVersion`) / soft-or-permanent delete / recycle.                                                                                             |
| `POST`                      | `/api/memory/l2/{id}/regenerate` | Enqueue a regeneration task for the L2 scene — body: `{ reason? }` (optional). `409` when >15 errors in the rolling window.                                                    |
| `GET`                       | `/api/memory/l3`                 | Read the current L3 persona — `?sessionId=` optional; returns `{ data: [...] }`.                                                                                               |
| `POST`                      | `/api/memory/l3`                 | Upsert the persona — body: `{ content, promptMode: "chat"\|"code", expectedVersion? }`. Stale `expectedVersion` → 409.                                                         |
| `GET`/`PUT`/`DELETE`        | `/api/memory/l3/{id}`            | Read / upsert / delete the persona. Delete mode: `"soft"\|"restore"\|"permanent"`.                                                                                             |

### Maintenance

| Method   | Path                                 | Description                                                                                                                             |
| -------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/memory/distillation-model`     | Inspect the effective selector — returns `{ provider, modelId, sourceLayer, scope, apiKeyId }` per tier (`self`/`global`/`env`/`auto`). |
| `PUT`    | `/api/memory/distillation-model`     | Set a selector — body: `{ provider, modelId, scope: "self"\|"global", apiKeyId? }`. Management only for `apiKeyId` targeting.           |
| `DELETE` | `/api/memory/distillation-model`     | Clear a selector tier — body: `{ scope, apiKeyId? }`.                                                                                   |
| `GET`    | `/api/memory/distillation-model/dlq` | List failed distillation tasks — `?limit=`, `?statuses=`. Returns `{ data, pagination }`.                                               |
| `POST`   | `/api/memory/distillation-model/dlq` | Retry — body: `{ ids: [...] }` or `{ all: true }` (exactly one required).                                                               |

> **Removed (v3.x routes, no replacement):** `/api/memory` (root CRUD), `/api/memory/{id}` (single-entry CRUD), `/api/memory/health`, `/api/memory/engine-status`, `/api/memory/reindex`, `/api/memory/retrieve-preview`, `/api/memory/summarize`, `/api/memory/embedding-providers`, `/api/settings/memory`, `/api/settings/qdrant/*`. These routes are gone; clients calling them receive `404 Not Found`. There is **no compat shim** — operators must migrate to the four-layer endpoints above.

## MCP Tools (`open-sse/mcp-server/tools/memoryTools.ts`)

The v3.x MCP tools (`omniroute_memory_search`, `omniroute_memory_add`, `omniroute_memory_clear`) are replaced by five owner-scoped read tools:

| Tool                         | Args                                                         | Returns                                              |
| ---------------------------- | ------------------------------------------------------------ | ---------------------------------------------------- |
| `omniroute_memory_l0_search` | `{ query, sessionId?, scene?, limit?, apiKeyId?, ownerId? }` | L0 raw-trace hits (`{ layer, items, count, total }`) |
| `omniroute_memory_l1_search` | `{ query, sessionId?, scene?, limit?, apiKeyId?, ownerId? }` | L1 curated-memory hits (same envelope)               |
| `omniroute_memory_l2_read`   | `{ id, apiKeyId?, ownerId? }`                                | One L2 scene (`{ found, scene }`)                    |
| `omniroute_memory_l3_read`   | `{ sessionId?, apiKeyId?, ownerId? }`                        | Current persona (`{ found, persona }`)               |
| `omniroute_memory_list`      | `{ sessionId?, scene?, limit?, apiKeyId?, ownerId? }`        | Aggregate of all four layers                         |

All five require the `read:memory` scope, and all five fail closed via `assertCallerOwner`: the caller principal (API key) is the only acceptable `apiKeyId`/`ownerId`; cross-tenant ids are rejected. The A2A Agent Card `metadata.totalSkills = 42` count is unchanged.

## A2A Skills

The A2A skill set is **preserved with the `memory` capability removed from each skill**. The five built-in skills (`smart-routing`, `quota-management`, `provider-discovery`, `cost-analysis`, `health-report`) keep their existing handlers but no longer inject memory into their internal LLM calls and never call `omniroute_memory_*` tools. See [A2A-SERVER.md](./A2A-SERVER.md) § "Built-in skills" — the row count (6 skills) and `metadata.totalSkills = 42` are unchanged.

## CLI commands

The v3.x `omniroute memory ...` commands are replaced by layer-scoped commands (`bin/cli/commands/memory.mjs`):

```
omniroute memory l0 search <query>   [--session <id>] [--scene <name>] [--limit 1-100]
omniroute memory l1 search <query>   [--session <id>] [--scene <name>] [--limit 1-100]
omniroute memory l2 read <id>
omniroute memory l3 read             [--session <id>]
omniroute memory list                [--session <id>] [--scene <name>] [--limit 1-100]
omniroute memory distillation-model get    [--api-key-id <id>]
omniroute memory distillation-model set <provider> <model-id> [--scope self|global] [--api-key-id <id>]
omniroute memory distillation-model delete [--scope self|global] [--api-key-id <id>]
omniroute memory dlq list            [--limit 1-200] [--statuses <list>]
omniroute memory dlq retry [ids...]  [--all] [--yes]
```

## L1 Types

Seven L1 types, all stored in `memory.db` under the `l1_memories` table:

| Type            | Used for                                | Example                                                  |
| --------------- | --------------------------------------- | -------------------------------------------------------- |
| `persona`       | Who the user is — role, style, standing | "Backend engineer, 5y Python + Go"                       |
| `episodic`      | A specific past event or exchange       | "On 2026-08-01 we debugged the rate-limit leak together" |
| `instruction`   | A user-given directive that persists    | "Always use UTC in timestamps"                           |
| `work_fact`     | A stable project/work domain fact       | "Repo: my-app — uses FastAPI + uv"                       |
| `work_task`     | An open or completed work item          | "Migrate the auth module to JWT"                         |
| `work_method`   | A preferred way of doing the work       | "User usually commits before pushing"                    |
| `work_artifact` | A named deliverable/document/artifact   | "API reference lives in docs/reference"                  |

Each L1 row carries `priority` (0–100), `sceneName`, `sourceMessageIds`, and `metadata`; edits are optimistic (a stale `expectedVersion` → 409). `lastModifiedBy` distinguishes `user` vs `pipeline` writers, and `editedByUser` marks user-authored rows.

## Capturing into L0

L0 capture is **verbatim**: the assistant's visible response text and the user's message text are written as-is, with role tags and timestamps. There is no regex extraction step in the L0 path (the v3.x `extraction.ts` module is gone). L1/L2/L3 production is LLM-driven and runs in the background worker above. Inserts are idempotent per `idempotencyKey` — a retried turn never duplicates a row.

When PII redaction is enabled (`PII_REDACTION_ENABLED=true`), the L0 write happens **after** the request-side redaction pass — L0 never contains raw PII when the flag is on. When the flag is off (the default), L0 contains the verbatim text; operators who need redaction must opt in.

## Delete & regenerate semantics

| Path                                  | Effect                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `DELETE /api/memory/{l0,l1,l2}/{id}`  | Soft (`mode: "soft"`) or permanent (`mode: "permanent"`) delete of one record. Soft-deleted rows recycle. |
| `DELETE /api/memory/l3/{id}`          | Same, plus `mode: "restore"` to restore a soft-deleted persona.                                           |
| `POST /api/memory/l0?sessionId=...`   | Soft/permanent delete of an entire L0 session.                                                            |
| `POST /api/memory/l2/{id}/regenerate` | Enqueues a `L2_scene` regeneration task; 409 past the rolling-window error cap.                           |
| DLQ retry                             | `POST /api/memory/distillation-model/dlq` with `ids` or `all` — manual, no automatic retry loop.          |

There is no `compact`/`summarize`/`reset` endpoint and no script that deletes `memory.db` — growth is bounded by the L2 active cap (≤15/owner) and by explicit deletes.

## Performance

| Path                    | Read shape                                   | p50 (local)     | Notes                                                                  |
| ----------------------- | -------------------------------------------- | --------------- | ---------------------------------------------------------------------- |
| L0 listing              | Indexed scan on session/owner boundary       | < 5ms           | Idempotent inserts; append-only                                        |
| L1 FTS5 search          | `searchL1()` — FTS5 `MATCH` on `l1_memories` | < 10ms          | Authoritative retrieval path                                           |
| L1 recall (1k rows)     | Owner-scoped top-K scoring                   | ~6 ms           | Benchmark pinned in `tests/integration/performance-regression.test.ts` |
| L2 listing              | Owner-scoped scene listing (≤15 active)      | < 3ms           | Cap enforced by service                                                |
| L3 read                 | Owner-scoped persona singleton               | < 2ms           | One row per owner                                                      |
| Background distillation | Per-task LLM call                            | model-dependent | Concurrency capped by `MEMORY_DISTILLATION_CONCURRENCY` (default 3)    |

## See Also

- [SKILLS.md](./SKILLS.md) — `skillsEnabled` continues to inject tool definitions independently of memory.
- [MCP-SERVER.md](./MCP-SERVER.md) — MCP transport, scopes, and the five memory tools above.
- [API_REFERENCE.md](../reference/API_REFERENCE.md) — broader API surface, including the new four-layer routes.
- [A2A-SERVER.md](./A2A-SERVER.md) — built-in skills (memory capability removed; surface otherwise unchanged).
- [Environment](../reference/ENVIRONMENT.md#17-memory-optimization) — environment variables for the memory subsystem.
- Source modules:
  - `src/memory/db/core.ts` — standalone `memory.db` open + WAL; `service.ts` — the four-layer service; `migrations/` + `repositories/`
  - `src/memory/l0.ts`, `l1.ts`, `l2.ts`, `l3.ts` — layer CRUD (pure behavior; the TencentDB Agent Memory port lives in `src/memory/tencent/`)
  - `src/memory/distillation/` — worker, scheduler, permit, executor, selector, DLQ, internal marker
  - `src/memory/recall/` + `src/memory/retrieval/` — owner-scoped recall facade and FTS5/RRF retrieval
  - `src/memory/integration/` — pipeline seams: settings resolver, L0 capture, injection transformer, distillation runtime/queue
  - `src/memory/vectorStore.ts` — best-effort sqlite-vec (RRF k=60); FTS5 remains authoritative
  - `src/app/api/memory/{l0,l1,l2,l3,distillation-model,distillation-model/dlq}/route.ts`
  - `open-sse/handlers/chatCore.ts` — capture/injection wiring; `chatCore/headers.ts::isNoMemoryRequested`
  - `open-sse/mcp-server/tools/memoryTools.ts` — five owner-scoped read tools

---

## Vector retrieval (best-effort)

FTS5 is the **authoritative** L1 retrieval surface and always works. The optional sqlite-vec hybrid (`src/memory/vectorStore.ts`) loads lazily and degrades to `null` whenever `sqlite-vec` is unavailable (cloud/WASM) or `VECTOR_STORE_DISABLE_VEC=true`; callers must fall back to FTS5. The pure fusion primitive lives in `src/memory/retrieval/rrf.ts` (RRF k=60). There is no embedding-provider route and no embedding-source configuration surface — embedding sources were a v3.x feature removed by the cutover.
