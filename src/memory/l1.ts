/**
 * src/memory/l1.ts
 *
 * L1 — structured memories. 7 types; priority 0..100; versioned in-place updates.
 * Each version is a separate row under the same `id`. The current/latest version
 * is the row with the highest version for that id and not tombstoned.
 */

import { randomUUID } from "node:crypto";
import { getMemoryDbInstance } from "./db/core.ts";
import type {
  L1CreateInput,
  L1ListFilter,
  L1Memory,
  L1Type,
  L1UpdateInput,
  MemoryPriority,
  Owner,
} from "./types.ts";
import { L1_TYPES, ownerKey } from "./types.ts";

const VALID_TYPES: ReadonlySet<L1Type> = new Set(L1_TYPES);

function validateCreate(input: L1CreateInput): void {
  if (!VALID_TYPES.has(input.type)) {
    throw new Error(`[memory.l1] invalid type: ${input.type} (expected ${L1_TYPES.join("|")})`);
  }
  if (
    typeof input.priority !== "number" ||
    !Number.isFinite(input.priority) ||
    input.priority < 0 ||
    input.priority > 100
  ) {
    throw new Error("[memory.l1] priority must be 0..100");
  }
  if (
    !input.owner ||
    typeof input.owner.teamId !== "string" ||
    typeof input.owner.userId !== "string" ||
    typeof input.owner.agentId !== "string"
  ) {
    throw new Error("[memory.l1] owner must include teamId, userId, agentId (strings)");
  }
  if (!input.content || typeof input.content !== "string") {
    throw new Error("[memory.l1] content is required");
  }
  if (!input.sceneName || typeof input.sceneName !== "string") {
    throw new Error("[memory.l1] sceneName is required");
  }
  if (input.lastModifiedBy !== "user" && input.lastModifiedBy !== "pipeline") {
    throw new Error("[memory.l1] lastModifiedBy must be user|pipeline");
  }
}

function parseJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      return v as string[];
    }
  } catch {
    /* ignore */
  }
  return [];
}

function parseJsonObject(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return {};
}

export function createMemory(input: L1CreateInput): L1Memory {
  validateCreate(input);
  const db = getMemoryDbInstance();
  const key = ownerKey(input.owner);
  const id = randomUUID();
  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO l1_memories (
        id, version, owner_key, team_id, user_id, agent_id,
        type, priority, scene_name, source_message_ids, metadata, pipeline_key,
        content, last_modified_by, edited_by_user, created_at, updated_at,
        tombstone
      ) VALUES (
        @id, 1, @owner_key, @team_id, @user_id, @agent_id,
        @type, @priority, @scene_name, @source_message_ids, @metadata, @pipeline_key,
        @content, @last_modified_by, @edited_by_user, @created_at, @updated_at,
        0
      )`
    ).run({
      id,
      owner_key: key,
      team_id: input.owner.teamId,
      user_id: input.owner.userId,
      agent_id: input.owner.agentId,
      type: input.type,
      priority: input.priority,
      scene_name: input.sceneName,
      source_message_ids: JSON.stringify(input.sourceMessageIds ?? []),
      metadata: JSON.stringify(input.metadata ?? {}),
      pipeline_key: input.pipelineKey ?? null,
      content: input.content,
      last_modified_by: input.lastModifiedBy,
      edited_by_user: input.editedByUser ? 1 : 0,
      created_at: now,
      updated_at: now,
    });
  })();

  return {
    id,
    ownerKey: key,
    teamId: input.owner.teamId,
    userId: input.owner.userId,
    agentId: input.owner.agentId,
    type: input.type,
    priority: input.priority,
    sceneName: input.sceneName,
    sourceMessageIds: input.sourceMessageIds ?? [],
    metadata: input.metadata ?? {},
    pipelineKey: input.pipelineKey ?? null,
    content: input.content,
    version: 1,
    createdAt: now,
    updatedAt: now,
    lastModifiedBy: input.lastModifiedBy,
    editedByUser: input.editedByUser,
    deletedAt: null,
    tombstone: false,
  };
}

export class MemoryVersionConflictError extends Error {
  readonly current: L1Memory;

  constructor(current: L1Memory) {
    super(`[memory.l1] version conflict: expected an older version, current=${current.version}`);
    this.name = "MemoryVersionConflictError";
    this.current = current;
  }
}

export function updateMemory(
  id: string,
  owner: Owner,
  update: L1UpdateInput,
  expectedVersion?: number
): L1Memory {
  const db = getMemoryDbInstance();
  const key = ownerKey(owner);
  let result: L1Memory | null = null;

  db.transaction(() => {
    const current = db
      .prepare(
        `SELECT * FROM l1_memories WHERE id = ? AND owner_key = ? AND deleted_at IS NULL
         ORDER BY version DESC LIMIT 1`
      )
      .get(id, key) as L1Row | undefined;
    if (!current) {
      throw new Error(`[memory.l1] memory not found or owner mismatch: id=${id} owner=${key}`);
    }
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new MemoryVersionConflictError(rowToMemory(current));
    }

    const nextVersion = current.version + 1;
    const now = new Date().toISOString();
    const merged = {
      content: update.content ?? current.content,
      priority: (update.priority ?? current.priority) as MemoryPriority,
      sceneName: update.sceneName ?? current.scene_name,
      sourceMessageIds: update.sourceMessageIds ?? parseJsonArray(current.source_message_ids),
      metadata: update.metadata ?? parseJsonObject(current.metadata),
      pipelineKey: update.pipelineKey !== undefined ? update.pipelineKey : current.pipeline_key,
      lastModifiedBy: update.lastModifiedBy ?? current.last_modified_by,
      editedByUser: update.editedByUser ?? current.edited_by_user === 1,
    };

    if (
      typeof merged.priority !== "number" ||
      !Number.isFinite(merged.priority) ||
      merged.priority < 0 ||
      merged.priority > 100
    ) {
      throw new Error("[memory.l1] priority must be 0..100");
    }
    if (merged.lastModifiedBy !== "user" && merged.lastModifiedBy !== "pipeline") {
      throw new Error("[memory.l1] lastModifiedBy must be user|pipeline");
    }

    db.prepare(
      `UPDATE l1_memories SET tombstone = 1, deleted_at = COALESCE(deleted_at, datetime('now'))
       WHERE id = ? AND version = ? AND owner_key = ?`
    ).run(id, current.version, key);

    db.prepare(
      `INSERT INTO l1_memories (
        id, version, owner_key, team_id, user_id, agent_id,
        type, priority, scene_name, source_message_ids, metadata, pipeline_key,
        content, last_modified_by, edited_by_user, created_at, updated_at,
        tombstone
      ) VALUES (
        @id, @version, @owner_key, @team_id, @user_id, @agent_id,
        @type, @priority, @scene_name, @source_message_ids, @metadata, @pipeline_key,
        @content, @last_modified_by, @edited_by_user, @created_at, @updated_at,
        0
      )`
    ).run({
      id,
      version: nextVersion,
      owner_key: key,
      team_id: current.team_id,
      user_id: current.user_id,
      agent_id: current.agent_id,
      type: current.type,
      priority: merged.priority,
      scene_name: merged.sceneName,
      source_message_ids: JSON.stringify(merged.sourceMessageIds),
      metadata: JSON.stringify(merged.metadata),
      pipeline_key: merged.pipelineKey,
      content: merged.content,
      last_modified_by: merged.lastModifiedBy,
      edited_by_user: merged.editedByUser ? 1 : 0,
      created_at: current.created_at,
      updated_at: now,
    });

    result = rowToMemory(
      db
        .prepare("SELECT * FROM l1_memories WHERE id = ? AND version = ?")
        .get(id, nextVersion) as L1Row
    );
  })();

  return result!;
}

export function getMemoryById(id: string, owner: Owner): L1Memory | null {
  const db = getMemoryDbInstance();
  const key = ownerKey(owner);
  const row = db
    .prepare(
      `SELECT * FROM l1_memories WHERE id = ? AND owner_key = ? AND deleted_at IS NULL
       ORDER BY version DESC LIMIT 1`
    )
    .get(id, key) as L1Row | undefined;
  return row ? rowToMemory(row) : null;
}

export function getMemoryByPipelineKey(
  pipelineKey: string,
  owner: Owner,
  options: { includeDeleted?: boolean } = {}
): L1Memory | null {
  const key = ownerKey(owner);
  const deletedClause = options.includeDeleted ? "" : "AND deleted_at IS NULL AND tombstone = 0";
  const row = getMemoryDbInstance()
    .prepare(
      `SELECT * FROM l1_memories
       WHERE owner_key = ? AND pipeline_key = ? ${deletedClause}
       ORDER BY version DESC LIMIT 1`
    )
    .get(key, pipelineKey) as L1Row | undefined;
  return row ? rowToMemory(row) : null;
}

export function getMemoryHistory(id: string, owner: Owner): L1Memory[] {
  const db = getMemoryDbInstance();
  const key = ownerKey(owner);
  const rows = db
    .prepare(
      `SELECT * FROM l1_memories WHERE id = ? AND owner_key = ?
       ORDER BY version ASC`
    )
    .all(id, key) as L1Row[];
  return rows.map(rowToMemory);
}

export function listMemories(filter: L1ListFilter): L1Memory[] {
  const db = getMemoryDbInstance();
  const key = ownerKey(filter.owner);
  const clauses: string[] = ["owner_key = ?"];
  const params: unknown[] = [key];
  if (!filter.includeDeleted) {
    clauses.push("deleted_at IS NULL");
    clauses.push("tombstone = 0");
  }
  if (filter.type) {
    if (!VALID_TYPES.has(filter.type)) {
      throw new Error(`[memory.l1] invalid type filter: ${filter.type}`);
    }
    clauses.push("type = ?");
    params.push(filter.type);
  }
  if (filter.sceneName) {
    clauses.push("scene_name = ?");
    params.push(filter.sceneName);
  }
  // Only show the latest live version per id.
  // For includeDeleted=true we use the most recent version regardless of
  // tombstone, since soft-delete sets tombstone=1.
  if (filter.includeDeleted) {
    const sql = `SELECT * FROM l1_memories WHERE ${clauses.join(" AND ")}
                 AND version = (
                   SELECT MAX(version) FROM l1_memories m2
                   WHERE m2.id = l1_memories.id
                 )
                 ORDER BY updated_at DESC`;
    const rows = db.prepare(sql).all(...params) as L1Row[];
    return rows.map(rowToMemory);
  }
  const sql = `SELECT * FROM l1_memories WHERE ${clauses.join(" AND ")}
               AND version = (
                 SELECT MAX(version) FROM l1_memories m2
                 WHERE m2.id = l1_memories.id AND m2.deleted_at IS NULL
               )
               ORDER BY updated_at DESC`;
  const rows = db.prepare(sql).all(...params) as L1Row[];
  return rows.map(rowToMemory);
}

export function searchMemories(args: { owner: Owner; query: string }): L1Memory[] {
  const db = getMemoryDbInstance();
  const key = ownerKey(args.owner);
  const phrase = `"${args.query.replace(/"/g, '""')}"`;
  const rows = db
    .prepare(
      `SELECT m.* FROM l1_memories m
       JOIN l1_fts f ON f.rowid = m.rowid
       WHERE m.owner_key = ?
         AND m.deleted_at IS NULL
         AND m.tombstone = 0
         AND l1_fts MATCH ?
         AND m.version = (
           SELECT MAX(version) FROM l1_memories m2
           WHERE m2.id = m.id AND m2.deleted_at IS NULL
         )
       ORDER BY rank`
    )
    .all(key, phrase) as L1Row[];
  return rows.map(rowToMemory);
}

export function softDeleteMemory(id: string, owner: Owner): void {
  const db = getMemoryDbInstance();
  const key = ownerKey(owner);
  db.transaction(() => {
    db.prepare(
      `UPDATE l1_memories
     SET deleted_at = datetime('now'), tombstone = 1,
         last_modified_by = 'user', edited_by_user = 1,
         updated_at = datetime('now')
     WHERE id = ? AND owner_key = ? AND deleted_at IS NULL`
    ).run(id, key);
  })();
}

export function restoreMemory(id: string, owner: Owner): void {
  const db = getMemoryDbInstance();
  const key = ownerKey(owner);
  db.prepare(
    `UPDATE l1_memories SET deleted_at = NULL, tombstone = 0
     WHERE id = ? AND owner_key = ?`
  ).run(id, key);
}

export function permanentDeleteMemory(id: string, owner: Owner): void {
  const db = getMemoryDbInstance();
  const key = ownerKey(owner);
  db.prepare("DELETE FROM l1_memories WHERE id = ? AND owner_key = ?").run(id, key);
}

// ──────────────── Row mapping ────────────────

interface L1Row {
  id: string;
  version: number;
  owner_key: string;
  team_id: string;
  user_id: string;
  agent_id: string;
  type: L1Type;
  priority: number;
  scene_name: string;
  source_message_ids: string;
  metadata: string;
  pipeline_key: string | null;
  content: string;
  last_modified_by: "user" | "pipeline";
  edited_by_user: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  tombstone: number;
}

function rowToMemory(r: L1Row): L1Memory {
  return {
    id: r.id,
    ownerKey: r.owner_key,
    teamId: r.team_id,
    userId: r.user_id,
    agentId: r.agent_id,
    type: r.type,
    priority: r.priority,
    sceneName: r.scene_name,
    sourceMessageIds: parseJsonArray(r.source_message_ids),
    metadata: parseJsonObject(r.metadata),
    pipelineKey: r.pipeline_key,
    content: r.content,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastModifiedBy: r.last_modified_by,
    editedByUser: r.edited_by_user === 1,
    deletedAt: r.deleted_at,
    tombstone: r.tombstone === 1,
  };
}
