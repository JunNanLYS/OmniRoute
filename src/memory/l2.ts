/**
 * src/memory/l2.ts
 *
 * L2 — scenes. Max 15 active scenes per owner. (scene_name, group_key) is the
 * natural key for upsert. UPDATE>MERGE>CREATE-compatible primitives exposed as
 * `upsertScene` (created = !existed; mergeHeat = average of existing+incoming heat).
 *
 * Soft delete via deleted_at; restore clears it; permanent delete removes the row.
 * When a scene is soft- or permanent-deleted, the active-scene slot is freed.
 */

import { randomUUID } from "node:crypto";
import { getMemoryDbInstance } from "./db/core.ts";
import type {
  L2CreateInput,
  L2ListFilter,
  L2Scene,
  L2UpsertInput,
  L2UpsertResult,
  Owner,
} from "./types.ts";
import { L2_MAX_ACTIVE_PER_OWNER, ownerKey } from "./types.ts";

function validate(input: L2CreateInput | L2UpsertInput): void {
  if (!input.owner || !input.owner.teamId || !input.owner.userId || !input.owner.agentId) {
    throw new Error("[memory.l2] owner must include teamId, userId, agentId");
  }
  if (!input.sceneName || typeof input.sceneName !== "string") {
    throw new Error("[memory.l2] sceneName is required");
  }
  if (
    typeof input.heat !== "number" ||
    !Number.isFinite(input.heat) ||
    input.heat < 0 ||
    input.heat > 1
  ) {
    throw new Error("[memory.l2] heat must be in 0..1");
  }
  if (input.lastModifiedBy !== "user" && input.lastModifiedBy !== "pipeline") {
    throw new Error("[memory.l2] lastModifiedBy must be user|pipeline");
  }
}

function countActive(ownerKeyStr: string): number {
  const db = getMemoryDbInstance();
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM l2_scenes WHERE owner_key = ? AND deleted_at IS NULL")
    .get(ownerKeyStr) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function createScene(input: L2CreateInput): L2Scene {
  validate(input);
  const db = getMemoryDbInstance();
  const key = ownerKey(input.owner);

  if (countActive(key) >= L2_MAX_ACTIVE_PER_OWNER) {
    throw new Error(`[memory.l2] max active scenes per owner reached (${L2_MAX_ACTIVE_PER_OWNER})`);
  }

  // Reject duplicates of (scene_name, group_key) for active rows.
  const existing = db
    .prepare(
      `SELECT id FROM l2_scenes
       WHERE owner_key = ? AND scene_name = ? AND deleted_at IS NULL
         AND ((group_key IS NULL AND ? IS NULL) OR group_key = ?)`
    )
    .get(key, input.sceneName, input.groupKey ?? null, input.groupKey ?? null) as
    { id: string } | undefined;
  if (existing) {
    throw new Error(
      `[memory.l2] scene already exists for owner: scene_name=${input.sceneName} group_key=${input.groupKey ?? null}`
    );
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO l2_scenes (
      id, owner_key, team_id, user_id, agent_id,
      scene_name, group_key, summary, heat, content,
      last_modified_by, edited_by_user, created_at, updated_at
    ) VALUES (
      @id, @owner_key, @team_id, @user_id, @agent_id,
      @scene_name, @group_key, @summary, @heat, @content,
      @last_modified_by, @edited_by_user, @created_at, @updated_at
    )`
  ).run({
    id,
    owner_key: key,
    team_id: input.owner.teamId,
    user_id: input.owner.userId,
    agent_id: input.owner.agentId,
    scene_name: input.sceneName,
    group_key: input.groupKey ?? null,
    summary: input.summary,
    heat: input.heat,
    content: input.content,
    last_modified_by: input.lastModifiedBy,
    edited_by_user: input.editedByUser ? 1 : 0,
    created_at: now,
    updated_at: now,
  });

  return {
    id,
    ownerKey: key,
    teamId: input.owner.teamId,
    userId: input.owner.userId,
    agentId: input.owner.agentId,
    sceneName: input.sceneName,
    groupKey: input.groupKey ?? null,
    summary: input.summary,
    heat: input.heat,
    content: input.content,
    createdAt: now,
    updatedAt: now,
    version: 1,
    lastModifiedBy: input.lastModifiedBy,
    editedByUser: input.editedByUser,
    deletedAt: null,
  };
}

export function upsertScene(input: L2UpsertInput): L2UpsertResult {
  validate(input);
  const db = getMemoryDbInstance();
  const key = ownerKey(input.owner);
  const groupKey = input.groupKey;

  const existing = db
    .prepare(
      `SELECT * FROM l2_scenes
       WHERE owner_key = ? AND scene_name = ?
         AND ((group_key IS NULL AND ? IS NULL) OR group_key = ?)
         AND deleted_at IS NULL
       LIMIT 1`
    )
    .get(key, input.sceneName, groupKey, groupKey) as L2Row | undefined;

  if (existing) {
    const mergedHeat = input.mergeHeat === true ? (existing.heat + input.heat) / 2 : input.heat;
    const nextVersion = existing.version + 1;
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE l2_scenes
       SET summary = ?, heat = ?, content = ?, version = ?,
           last_modified_by = ?, edited_by_user = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      input.summary,
      mergedHeat,
      input.content,
      nextVersion,
      input.lastModifiedBy,
      input.editedByUser ? 1 : 0,
      now,
      existing.id
    );
    const after = db.prepare("SELECT * FROM l2_scenes WHERE id = ?").get(existing.id) as L2Row;
    return { scene: rowToScene(after), created: false };
  }

  // CREATE branch — enforce the 15-cap.
  if (countActive(key) >= L2_MAX_ACTIVE_PER_OWNER) {
    throw new Error(`[memory.l2] max active scenes per owner reached (${L2_MAX_ACTIVE_PER_OWNER})`);
  }

  const created = createScene({
    owner: input.owner,
    sceneName: input.sceneName,
    groupKey: input.groupKey,
    summary: input.summary,
    heat: input.heat,
    content: input.content,
    lastModifiedBy: input.lastModifiedBy,
    editedByUser: input.editedByUser,
  });
  return { scene: created, created: true };
}

export class SceneVersionConflictError extends Error {
  readonly current: L2Scene;

  constructor(current: L2Scene) {
    super(`[memory.l2] version conflict: current=${current.version}`);
    this.name = "SceneVersionConflictError";
    this.current = current;
  }
}

export function updateScene(
  id: string,
  owner: Owner,
  update: Partial<Pick<L2Scene, "sceneName" | "groupKey" | "summary" | "heat" | "content">>,
  expectedVersion: number
): L2Scene {
  const db = getMemoryDbInstance();
  const key = ownerKey(owner);
  let result: L2Scene | null = null;

  db.transaction(() => {
    const current = db
      .prepare("SELECT * FROM l2_scenes WHERE id = ? AND owner_key = ? AND deleted_at IS NULL")
      .get(id, key) as L2Row | undefined;
    if (!current) {
      throw new Error(`[memory.l2] scene not found or owner mismatch: id=${id}`);
    }
    if (current.version !== expectedVersion) {
      throw new SceneVersionConflictError(rowToScene(current));
    }

    const sceneName = update.sceneName ?? current.scene_name;
    const groupKey = update.groupKey !== undefined ? update.groupKey : current.group_key;
    const summary = update.summary ?? current.summary;
    const heat = update.heat ?? current.heat;
    const content = update.content ?? current.content;
    validate({
      owner,
      sceneName,
      groupKey,
      summary,
      heat,
      content,
      lastModifiedBy: "user",
      editedByUser: true,
    });
    const now = new Date().toISOString();
    const changed = db
      .prepare(
        `UPDATE l2_scenes
         SET scene_name = ?, group_key = ?, summary = ?, heat = ?, content = ?,
             version = version + 1, last_modified_by = 'user', edited_by_user = 1,
             updated_at = ?
         WHERE id = ? AND owner_key = ? AND version = ? AND deleted_at IS NULL`
      )
      .run(sceneName, groupKey, summary, heat, content, now, id, key, expectedVersion);
    if (changed.changes !== 1) {
      const latest = db
        .prepare("SELECT * FROM l2_scenes WHERE id = ? AND owner_key = ? AND deleted_at IS NULL")
        .get(id, key) as L2Row | undefined;
      if (latest) throw new SceneVersionConflictError(rowToScene(latest));
      throw new Error(`[memory.l2] scene not found or owner mismatch: id=${id}`);
    }
    result = rowToScene(
      db.prepare("SELECT * FROM l2_scenes WHERE id = ? AND owner_key = ?").get(id, key) as L2Row
    );
  })();

  return result!;
}

export function getSceneById(id: string, owner: Owner): L2Scene | null {
  const db = getMemoryDbInstance();
  const key = ownerKey(owner);
  const row = db
    .prepare("SELECT * FROM l2_scenes WHERE id = ? AND owner_key = ? AND deleted_at IS NULL")
    .get(id, key) as L2Row | undefined;
  return row ? rowToScene(row) : null;
}

export function listScenes(filter: L2ListFilter): L2Scene[] {
  const db = getMemoryDbInstance();
  const key = ownerKey(filter.owner);
  const clauses: string[] = ["owner_key = ?"];
  const params: unknown[] = [key];
  if (!filter.includeDeleted) {
    clauses.push("deleted_at IS NULL");
  }
  const sql = `SELECT * FROM l2_scenes WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC`;
  const rows = db.prepare(sql).all(...params) as L2Row[];
  return rows.map(rowToScene);
}

export function listScenesOrderedByHeat(filter: L2ListFilter): L2Scene[] {
  const db = getMemoryDbInstance();
  const key = ownerKey(filter.owner);
  const clauses: string[] = ["owner_key = ?"];
  const params: unknown[] = [key];
  if (!filter.includeDeleted) {
    clauses.push("deleted_at IS NULL");
  }
  const sql = `SELECT * FROM l2_scenes WHERE ${clauses.join(" AND ")} ORDER BY heat DESC`;
  const rows = db.prepare(sql).all(...params) as L2Row[];
  return rows.map(rowToScene);
}

export function softDeleteScene(
  id: string,
  owner: Owner,
  lastModifiedBy: "user" | "pipeline" = "user"
): void {
  const db = getMemoryDbInstance();
  const key = ownerKey(owner);
  db.prepare(
    `UPDATE l2_scenes
     SET deleted_at = datetime('now'), tombstone = 1,
         last_modified_by = ?, edited_by_user = ?, updated_at = datetime('now')
     WHERE id = ? AND owner_key = ? AND deleted_at IS NULL`
  ).run(lastModifiedBy, lastModifiedBy === "user" ? 1 : 0, id, key);
}

export function restoreScene(id: string, owner: Owner): void {
  const db = getMemoryDbInstance();
  const key = ownerKey(owner);
  if (countActive(key) >= L2_MAX_ACTIVE_PER_OWNER) {
    throw new Error(`[memory.l2] max active scenes per owner reached (${L2_MAX_ACTIVE_PER_OWNER})`);
  }
  db.prepare(
    "UPDATE l2_scenes SET deleted_at = NULL, tombstone = 0 WHERE id = ? AND owner_key = ?"
  ).run(id, key);
}

export function permanentDeleteScene(id: string, owner: Owner): void {
  const db = getMemoryDbInstance();
  const key = ownerKey(owner);
  db.prepare("DELETE FROM l2_scenes WHERE id = ? AND owner_key = ?").run(id, key);
}

// ──────────────── Row mapping ────────────────

interface L2Row {
  id: string;
  owner_key: string;
  team_id: string;
  user_id: string;
  agent_id: string;
  scene_name: string;
  group_key: string | null;
  summary: string;
  heat: number;
  content: string;
  created_at: string;
  updated_at: string;
  version: number;
  last_modified_by: "user" | "pipeline";
  edited_by_user: number;
  deleted_at: string | null;
  tombstone: number;
}

function rowToScene(r: L2Row): L2Scene {
  return {
    id: r.id,
    ownerKey: r.owner_key,
    teamId: r.team_id,
    userId: r.user_id,
    agentId: r.agent_id,
    sceneName: r.scene_name,
    groupKey: r.group_key,
    summary: r.summary,
    heat: r.heat,
    content: r.content,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    version: r.version,
    lastModifiedBy: r.last_modified_by,
    editedByUser: r.edited_by_user === 1,
    deletedAt: r.deleted_at,
  };
}
