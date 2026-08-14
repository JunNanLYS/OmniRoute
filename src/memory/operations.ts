/**
 * Standalone memory operational metadata.
 *
 * Distillation queue/lock/DLQ state is owned exclusively by
 * `db/repositories/distillation.ts`; this module only owns the versioned
 * settings and embedding metadata tables.
 */

import { getMemoryDbInstance } from "./db/core.ts";
import type { EmbeddingMeta, MemorySetting } from "./types.ts";

export function getSetting(
  key: string,
  opts: { includeDeleted?: boolean } = {}
): MemorySetting | null {
  const db = getMemoryDbInstance();
  const sql = opts.includeDeleted
    ? "SELECT * FROM memory_settings WHERE key = ?"
    : "SELECT * FROM memory_settings WHERE key = ? AND deleted_at IS NULL";
  const row = db.prepare(sql).get(key) as MemorySettingRow | undefined;
  return row ? rowToSetting(row) : null;
}

export function upsertSetting(key: string, value: string): MemorySetting {
  const db = getMemoryDbInstance();
  db.transaction(() => {
    const existing = db.prepare("SELECT version FROM memory_settings WHERE key = ?").get(key) as
      { version: number } | undefined;
    if (existing) {
      db.prepare(
        `UPDATE memory_settings
         SET value = ?, version = ?, updated_at = datetime('now'), deleted_at = NULL
         WHERE key = ?`
      ).run(value, existing.version + 1, key);
    } else {
      db.prepare(`INSERT INTO memory_settings (key, value, version) VALUES (?, ?, 1)`).run(
        key,
        value
      );
    }
  })();
  return getSetting(key, { includeDeleted: true })!;
}

export function softDeleteSetting(key: string): void {
  getMemoryDbInstance()
    .prepare(
      "UPDATE memory_settings SET deleted_at = datetime('now') WHERE key = ? AND deleted_at IS NULL"
    )
    .run(key);
}

export function getEmbeddingMeta(): EmbeddingMeta | null {
  const row = getMemoryDbInstance().prepare("SELECT * FROM embedding_meta WHERE id = 1").get() as
    EmbeddingMetaRow | undefined;
  return row ? rowToEmbeddingMeta(row) : null;
}

export function upsertEmbeddingMeta(input: {
  signature: string;
  activeDim: number | null;
  source: string;
}): EmbeddingMeta {
  getMemoryDbInstance()
    .prepare(
      `UPDATE embedding_meta
       SET signature = ?, active_dim = ?, source = ?, updated_at = datetime('now')
       WHERE id = 1`
    )
    .run(input.signature, input.activeDim, input.source);
  return getEmbeddingMeta()!;
}

interface MemorySettingRow {
  key: string;
  value: string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function rowToSetting(row: MemorySettingRow): MemorySetting {
  return {
    key: row.key,
    value: row.value,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

interface EmbeddingMetaRow {
  signature: string | null;
  active_dim: number | null;
  source: string | null;
  vec_loaded: number;
  updated_at: string;
}

function rowToEmbeddingMeta(row: EmbeddingMetaRow): EmbeddingMeta {
  return {
    signature: row.signature,
    activeDim: row.active_dim,
    source: row.source,
    vecLoaded: row.vec_loaded === 1,
    updatedAt: row.updated_at,
  };
}
