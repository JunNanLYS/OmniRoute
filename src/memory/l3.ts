/**
 * src/memory/l3.ts
 *
 * L3 — persona. One active row per owner. Partial UNIQUE index on owner_key
 * (where deleted_at IS NULL) enforces the singleton invariant at the DB level.
 *
 * - upsertPersona: creates or updates the active persona in place.
 * - clearPersona: soft-deletes (sets deleted_at). Restore brings it back.
 * - permanentDeletePersona: removes the row entirely.
 * - getActivePersona(includeDeleted): for derived L2 nav; not stored.
 */

import { randomUUID } from "node:crypto";
import { getMemoryDbInstance } from "./db/core.ts";
import type { L3GetFilter, L3Persona, L3UpsertInput, Owner, PromptMode } from "./types.ts";
import { ownerKey } from "./types.ts";

const VALID_MODES: ReadonlySet<PromptMode> = new Set(["chat", "code"]);

function validate(input: L3UpsertInput): void {
  if (!input.owner || !input.owner.teamId || !input.owner.userId || !input.owner.agentId) {
    throw new Error("[memory.l3] owner must include teamId, userId, agentId");
  }
  if (!VALID_MODES.has(input.promptMode)) {
    throw new Error("[memory.l3] promptMode must be chat|code");
  }
  if (input.lastModifiedBy !== "user" && input.lastModifiedBy !== "pipeline") {
    throw new Error("[memory.l3] lastModifiedBy must be user|pipeline");
  }
}

export class PersonaVersionConflictError extends Error {
  readonly current: L3Persona;

  constructor(current: L3Persona) {
    super(`[memory.l3] version conflict: current=${current.version}`);
    this.name = "PersonaVersionConflictError";
    this.current = current;
  }
}

export function upsertPersona(input: L3UpsertInput, expectedVersion?: number): L3Persona {
  validate(input);
  const db = getMemoryDbInstance();
  const key = ownerKey(input.owner);

  const existing = db
    .prepare("SELECT * FROM l3_personas WHERE owner_key = ? AND deleted_at IS NULL LIMIT 1")
    .get(key) as L3Row | undefined;

  const now = new Date().toISOString();
  if (existing) {
    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw new PersonaVersionConflictError(rowToPersona(existing));
    }
    const nextVersion = existing.version + 1;
    const changed = db
      .prepare(
        `UPDATE l3_personas
       SET content = ?, prompt_mode = ?, version = ?,
           last_modified_by = ?, edited_by_user = ?, updated_at = ?
       WHERE persona_id = ? AND version = ? AND deleted_at IS NULL`
      )
      .run(
        input.content,
        input.promptMode,
        nextVersion,
        input.lastModifiedBy,
        input.editedByUser ? 1 : 0,
        now,
        existing.persona_id,
        existing.version
      );
    if (changed.changes !== 1) {
      const current = db
        .prepare("SELECT * FROM l3_personas WHERE owner_key = ? AND deleted_at IS NULL LIMIT 1")
        .get(key) as L3Row | undefined;
      if (current) throw new PersonaVersionConflictError(rowToPersona(current));
      throw new Error("[memory.l3] persona disappeared during update");
    }
    const after = db
      .prepare("SELECT * FROM l3_personas WHERE persona_id = ?")
      .get(existing.persona_id) as L3Row;
    return rowToPersona(after);
  }

  // No active row. If there is a tombstoned persona for this owner, reuse it
  // (preserves persona_id continuity across clear/restore cycles). Otherwise
  // create a fresh row. The partial UNIQUE index on (owner_key WHERE
  // deleted_at IS NULL) guarantees only one active row per owner.
  const tombstoned = db
    .prepare(
      `SELECT * FROM l3_personas WHERE owner_key = ? AND deleted_at IS NOT NULL
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get(key) as L3Row | undefined;

  const personaId = tombstoned?.persona_id ?? randomUUID();
  if (tombstoned) {
    db.prepare(
      `UPDATE l3_personas
       SET content = ?, prompt_mode = ?, version = version + 1,
           last_modified_by = ?, edited_by_user = ?, updated_at = ?, deleted_at = NULL
       WHERE persona_id = ?`
    ).run(
      input.content,
      input.promptMode,
      input.lastModifiedBy,
      input.editedByUser ? 1 : 0,
      now,
      personaId
    );
    const after = db
      .prepare("SELECT * FROM l3_personas WHERE persona_id = ?")
      .get(personaId) as L3Row;
    return rowToPersona(after);
  }

  db.prepare(
    `INSERT INTO l3_personas (
      persona_id, owner_key, team_id, user_id, agent_id,
      content, prompt_mode, created_at, updated_at, version,
      last_modified_by, edited_by_user
    ) VALUES (
      @persona_id, @owner_key, @team_id, @user_id, @agent_id,
      @content, @prompt_mode, @created_at, @updated_at, 1,
      @last_modified_by, @edited_by_user
    )`
  ).run({
    persona_id: personaId,
    owner_key: key,
    team_id: input.owner.teamId,
    user_id: input.owner.userId,
    agent_id: input.owner.agentId,
    content: input.content,
    prompt_mode: input.promptMode,
    created_at: now,
    updated_at: now,
    last_modified_by: input.lastModifiedBy,
    edited_by_user: input.editedByUser ? 1 : 0,
  });

  return {
    personaId,
    ownerKey: key,
    teamId: input.owner.teamId,
    userId: input.owner.userId,
    agentId: input.owner.agentId,
    content: input.content,
    promptMode: input.promptMode,
    version: 1,
    createdAt: now,
    updatedAt: now,
    lastModifiedBy: input.lastModifiedBy,
    editedByUser: input.editedByUser,
    deletedAt: null,
  };
}

export function getActivePersona(owner: Owner, opts: L3GetFilter = {}): L3Persona | null {
  const db = getMemoryDbInstance();
  const key = ownerKey(owner);
  const sql = opts.includeDeleted
    ? "SELECT * FROM l3_personas WHERE owner_key = ? ORDER BY updated_at DESC LIMIT 1"
    : "SELECT * FROM l3_personas WHERE owner_key = ? AND deleted_at IS NULL LIMIT 1";
  const row = db.prepare(sql).get(key) as L3Row | undefined;
  return row ? rowToPersona(row) : null;
}

export function clearPersona(owner: Owner): void {
  const db = getMemoryDbInstance();
  const key = ownerKey(owner);
  db.prepare(
    `UPDATE l3_personas
     SET deleted_at = datetime('now'), last_modified_by = 'user', edited_by_user = 1,
         updated_at = datetime('now')
     WHERE owner_key = ? AND deleted_at IS NULL`
  ).run(key);
}

export function restorePersona(owner: Owner): void {
  const db = getMemoryDbInstance();
  const key = ownerKey(owner);
  // If there is already an active row, leave it. Otherwise un-soft-delete the
  // most recent tombstoned row (preserves persona_id continuity).
  const active = db
    .prepare(
      "SELECT persona_id FROM l3_personas WHERE owner_key = ? AND deleted_at IS NULL LIMIT 1"
    )
    .get(key) as { persona_id: string } | undefined;
  if (active) return;
  db.prepare(
    `UPDATE l3_personas SET deleted_at = NULL
     WHERE persona_id = (
       SELECT persona_id FROM l3_personas WHERE owner_key = ? AND deleted_at IS NOT NULL
       ORDER BY updated_at DESC LIMIT 1
     )`
  ).run(key);
}

export function permanentDeletePersona(owner: Owner): void {
  const db = getMemoryDbInstance();
  const key = ownerKey(owner);
  db.prepare("DELETE FROM l3_personas WHERE owner_key = ?").run(key);
}

// ──────────────── Row mapping ────────────────

interface L3Row {
  persona_id: string;
  owner_key: string;
  team_id: string;
  user_id: string;
  agent_id: string;
  content: string;
  prompt_mode: PromptMode;
  created_at: string;
  updated_at: string;
  version: number;
  last_modified_by: "user" | "pipeline";
  edited_by_user: number;
  deleted_at: string | null;
}

function rowToPersona(r: L3Row): L3Persona {
  return {
    personaId: r.persona_id,
    ownerKey: r.owner_key,
    teamId: r.team_id,
    userId: r.user_id,
    agentId: r.agent_id,
    content: r.content,
    promptMode: r.prompt_mode,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastModifiedBy: r.last_modified_by,
    editedByUser: r.edited_by_user === 1,
    deletedAt: r.deleted_at,
  };
}
