/**
 * src/memory/l0.ts
 *
 * L0 — raw messages. Insert-only (no updateContent). Idempotent by `idempotencyKey`
 * within an owner. Soft-delete via deleted_at; restore undoes it; permanent delete
 * removes the row.
 *
 * All SQL is parameterized. Owner scope is mandatory — every query includes
 * `(owner_key, ...)` filters. No memory body is ever logged.
 */

import { randomUUID } from "node:crypto";
import { getMemoryDbInstance } from "./db/core.ts";
import type {
  L0InsertInput,
  L0InsertResult,
  L0ListFilter,
  L0Message,
  MessageRole,
  MessageSource,
  Owner,
} from "./types.ts";
import { ownerKey } from "./types.ts";

const VALID_ROLES: ReadonlySet<MessageRole> = new Set(["user", "assistant"]);
const VALID_SOURCES: ReadonlySet<MessageSource> = new Set(["user", "assistant", "imported"]);

function validate(input: L0InsertInput): void {
  if (!VALID_ROLES.has(input.role)) {
    throw new Error(`[memory.l0] invalid role: ${input.role} (expected user|assistant)`);
  }
  if (!VALID_SOURCES.has(input.source)) {
    throw new Error(
      `[memory.l0] invalid source: ${input.source} (expected user|assistant|imported)`
    );
  }
  if (!input.idempotencyKey || typeof input.idempotencyKey !== "string") {
    throw new Error("[memory.l0] idempotencyKey is required");
  }
  if (input.id !== undefined && (!input.id.trim() || input.id.length > 256)) {
    throw new Error("[memory.l0] explicit id must be 1..256 characters");
  }
  if (!input.owner || !input.owner.teamId || !input.owner.userId || !input.owner.agentId) {
    throw new Error("[memory.l0] owner must include teamId, userId, agentId");
  }
  if (!input.content || typeof input.content !== "string") {
    throw new Error("[memory.l0] content is required");
  }
}

export function insertMessage(input: L0InsertInput): L0InsertResult {
  validate(input);
  const db = getMemoryDbInstance();
  const key = ownerKey(input.owner);

  // Idempotent insert: try to find an existing row by (owner_key, idempotency_key).
  const existing = db
    .prepare("SELECT id FROM l0_messages WHERE owner_key = ? AND idempotency_key = ?")
    .get(key, input.idempotencyKey) as { id: string } | undefined;
  if (existing) {
    return { id: existing.id, inserted: false };
  }

  const id = input.id?.trim() || randomUUID();
  const timestamp = input.timestamp ?? new Date().toISOString();

  db.prepare(
    `INSERT INTO l0_messages (
      id, owner_key, team_id, user_id, agent_id,
      session_key, session_id, role, content, timestamp, source,
      correlation_id, combo_execution_key, is_internal, provider, model,
      truncated, idempotency_key
    ) VALUES (
      @id, @owner_key, @team_id, @user_id, @agent_id,
      @session_key, @session_id, @role, @content, @timestamp, @source,
      @correlation_id, @combo_execution_key, @is_internal, @provider, @model,
      @truncated, @idempotency_key
    )`
  ).run({
    id,
    owner_key: key,
    team_id: input.owner.teamId,
    user_id: input.owner.userId,
    agent_id: input.owner.agentId,
    session_key: input.sessionKey,
    session_id: input.sessionId,
    role: input.role,
    content: input.content,
    timestamp,
    source: input.source,
    correlation_id: input.correlationId,
    combo_execution_key: input.comboExecutionKey,
    is_internal: input.isInternal ? 1 : 0,
    provider: input.provider,
    model: input.model,
    truncated: input.truncated ? 1 : 0,
    idempotency_key: input.idempotencyKey,
  });

  return { id, inserted: true };
}

export function getMessageById(id: string, owner: Owner): L0Message | null {
  const db = getMemoryDbInstance();
  const key = ownerKey(owner);
  const row = db
    .prepare("SELECT * FROM l0_messages WHERE id = ? AND owner_key = ?")
    .get(id, key) as L0Row | undefined;
  return row ? rowToMessage(row) : null;
}

export function listMessages(filter: L0ListFilter): L0Message[] {
  const db = getMemoryDbInstance();
  const key = ownerKey(filter.owner);
  const clauses: string[] = ["owner_key = ?"];
  const params: unknown[] = [key];

  if (!filter.includeDeleted) {
    clauses.push("deleted_at IS NULL");
  }
  if (typeof filter.sessionId === "string") {
    clauses.push("session_id = ?");
    params.push(filter.sessionId);
  }
  if (typeof filter.isInternal === "boolean") {
    clauses.push("is_internal = ?");
    params.push(filter.isInternal ? 1 : 0);
  }

  const sql = `SELECT * FROM l0_messages WHERE ${clauses.join(" AND ")} ORDER BY recorded_at ASC`;
  const rows = db.prepare(sql).all(...params) as L0Row[];
  return rows.map(rowToMessage);
}

export interface L0DistillationMessage extends L0Message {
  cursorRowId: number;
}

export interface L0DistillationCursor {
  recordedAt: string;
  rowId: number;
}

export function listMessagesForDistillation(input: {
  owner: Owner;
  sessionId: string;
  after?: L0DistillationCursor | null;
  limit?: number;
}): L0DistillationMessage[] {
  const db = getMemoryDbInstance();
  const key = ownerKey(input.owner);
  const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 20)));
  const after = input.after ?? { recordedAt: "", rowId: 0 };
  const rows = db
    .prepare(
      `SELECT rowid AS cursor_row_id, * FROM l0_messages
       WHERE owner_key = ? AND session_id = ? AND deleted_at IS NULL
         AND is_internal = 0
         AND (recorded_at > ? OR (recorded_at = ? AND rowid > ?))
       ORDER BY recorded_at ASC, rowid ASC LIMIT ?`
    )
    .all(key, input.sessionId, after.recordedAt, after.recordedAt, after.rowId, limit) as Array<
    L0Row & { cursor_row_id: number }
  >;
  return rows.map((row) => ({
    ...rowToMessage(row),
    cursorRowId: Number(row.cursor_row_id),
  }));
}

export function searchMessages(args: { owner: Owner; query: string }): L0Message[] {
  const db = getMemoryDbInstance();
  const key = ownerKey(args.owner);
  // FTS5 interprets unquoted hyphens / colons as operator syntax. Wrap the
  // query in double quotes so it is treated as a literal phrase and any
  // hostile tokens (e.g. "evil:secret") don't break the query.
  const phrase = `"${args.query.replace(/"/g, '""')}"`;
  const rows = db
    .prepare(
      `SELECT m.* FROM l0_messages m
       JOIN l0_fts f ON f.rowid = m.rowid
       WHERE m.owner_key = ?
         AND m.deleted_at IS NULL
         AND l0_fts MATCH ?
       ORDER BY rank`
    )
    .all(key, phrase) as L0Row[];
  return rows.map(rowToMessage);
}

export function softDeleteMessage(id: string, owner: Owner): void {
  const db = getMemoryDbInstance();
  const key = ownerKey(owner);
  db.prepare(
    "UPDATE l0_messages SET deleted_at = datetime('now') WHERE id = ? AND owner_key = ? AND deleted_at IS NULL"
  ).run(id, key);
}

export function restoreMessage(id: string, owner: Owner): void {
  const db = getMemoryDbInstance();
  const key = ownerKey(owner);
  db.prepare("UPDATE l0_messages SET deleted_at = NULL WHERE id = ? AND owner_key = ?").run(
    id,
    key
  );
}

export function permanentDeleteMessage(id: string, owner: Owner): void {
  const db = getMemoryDbInstance();
  const key = ownerKey(owner);
  db.prepare("DELETE FROM l0_messages WHERE id = ? AND owner_key = ?").run(id, key);
}

// ──────────────── Row mapping ────────────────

interface L0Row {
  id: string;
  owner_key: string;
  team_id: string;
  user_id: string;
  agent_id: string;
  session_key: string;
  session_id: string | null;
  role: MessageRole;
  content: string;
  timestamp: string;
  recorded_at: string;
  source: MessageSource;
  correlation_id: string | null;
  combo_execution_key: string | null;
  is_internal: number;
  provider: string | null;
  model: string | null;
  truncated: number;
  deleted_at: string | null;
  idempotency_key: string;
}

function rowToMessage(r: L0Row): L0Message {
  return {
    id: r.id,
    ownerKey: r.owner_key,
    teamId: r.team_id,
    userId: r.user_id,
    agentId: r.agent_id,
    sessionKey: r.session_key,
    sessionId: r.session_id,
    role: r.role,
    content: r.content,
    timestamp: r.timestamp,
    recordedAt: r.recorded_at,
    source: r.source,
    correlationId: r.correlation_id,
    comboExecutionKey: r.combo_execution_key,
    isInternal: r.is_internal === 1,
    provider: r.provider,
    model: r.model,
    truncated: r.truncated === 1,
    deletedAt: r.deleted_at,
    idempotencyKey: r.idempotency_key,
  };
}
