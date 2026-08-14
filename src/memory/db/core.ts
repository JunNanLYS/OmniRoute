/**
 * src/memory/db/core.ts
 *
 * Standalone four-layer memory storage core — DB lifecycle.
 *
 * - Own lazy singleton: getMemoryDbInstance()
 * - File: `${DATA_DIR}/memory.db` (or `:memory:` under isCloud / isBuildPhase)
 * - PRAGMAs: journal_mode=WAL, busy_timeout=2000, synchronous=NORMAL, cache_size=65536, temp_store=MEMORY, mmap_size=best-effort
 * - Dedicated migrations directory with `_memory_migrations` tracking
 * - Idempotent transactional migrations (re-runnable)
 * - No backup system (per spec)
 * - Reuses tryOpenSync() from src/lib/db/adapters/driverFactory.ts and the SqliteAdapter contract
 */

import fs from "node:fs";
import path from "node:path";
import { isCloud, isBuildPhase } from "../../lib/db/core.ts";
import type { SqliteAdapter } from "../../lib/db/adapters/types.ts";
import { tryOpenSync } from "../../lib/db/adapters/driverFactory.ts";
import { sanitizeErrorMessage } from "../../../open-sse/utils/error.ts";

const MEMORY_DB_FILENAME = "memory.db";
const MMAP_FALLBACK_BYTES = 256 * 1024 * 1024; // 256 MiB
const DEFAULT_CACHE_SIZE = 65536;

// ──────────────── Path resolution ────────────────

function resolveMemoryDbFilePath(): string {
  if (isCloud || isBuildPhase) {
    return ":memory:";
  }
  const dataDir = process.env["DATA_DIR"] ?? defaultDataDir();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return path.join(dataDir, MEMORY_DB_FILENAME);
}

function defaultDataDir(): string {
  return process.platform === "win32"
    ? path.join(process.env["USERPROFILE"] ?? process.cwd(), ".omniroute")
    : path.join(process.env["HOME"] ?? process.cwd(), ".omniroute");
}

// ──────────────── Singleton ────────────────

let _instance: SqliteAdapter | null = null;
let _instancePath: string | null = null;

export function getMemoryDbFilePath(): string {
  return resolveMemoryDbFilePath();
}

export function isMemoryDbReady(): boolean {
  return _instance !== null && _instance.open === true;
}

export function getMemoryDbInstance(): SqliteAdapter {
  const filePath = resolveMemoryDbFilePath();
  if (_instance && _instance.open && _instancePath === filePath) {
    return _instance;
  }
  if (_instance && _instance.open) {
    // File path changed (tests or runtime swap); close and reopen.
    try {
      _instance.close();
    } catch {
      /* ignore */
    }
    _instance = null;
  }

  const opened = tryOpenSync(filePath);
  if (!opened) {
    throw new Error(
      `[memory.db] No synchronous SQLite driver available for ${filePath}. ` +
        "Tried bun:sqlite / better-sqlite3 / node:sqlite."
    );
  }

  applyPragmas(opened, filePath);
  runMemoryMigrations(opened);
  _instance = opened;
  _instancePath = filePath;
  return opened;
}

export function closeMemoryDbInstance(): boolean {
  if (!_instance) return false;
  const current = _instance;
  _instance = null;
  _instancePath = null;
  try {
    if (current.open && !isCloud && !isBuildPhase) {
      try {
        current.pragma("wal_checkpoint(TRUNCATE)");
      } catch (error: unknown) {
        const message = sanitizeErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
        console.warn("[memory.db] WAL checkpoint failed during close:", message);
      }
    }
  } finally {
    if (current.open) current.close();
  }
  return true;
}

export function resetMemoryDbInstance(): void {
  closeMemoryDbInstance();
}

function applyPragmas(db: SqliteAdapter, filePath: string): void {
  // WAL only applies to file-backed DBs; :memory: returns "memory" and we accept it.
  try {
    db.pragma("journal_mode = WAL");
  } catch (err: unknown) {
    const safe = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    // pragma failures are non-fatal (e.g. some cloud drivers reject WAL)
    if (!/not supported|not allowed/i.test(safe)) {
      // rethrow only if it is not a known-benign message

      console.debug(`[memory.db] journal_mode pragma failed: ${safe}`);
    }
  }
  try {
    db.pragma("busy_timeout = 2000");
  } catch {
    /* ignore */
  }
  try {
    db.pragma("synchronous = NORMAL");
  } catch {
    /* ignore */
  }
  try {
    db.pragma(`cache_size = -${DEFAULT_CACHE_SIZE}`);
  } catch {
    /* ignore */
  }
  try {
    db.pragma("temp_store = MEMORY");
  } catch {
    /* ignore */
  }
  // mmap_size is best-effort; not available in all runtimes (e.g. web)
  if (filePath !== ":memory:") {
    try {
      db.pragma(`mmap_size = ${MMAP_FALLBACK_BYTES}`);
    } catch {
      /* ignore */
    }
  }
}

// ──────────────── Migrations ────────────────

import { fileURLToPath } from "node:url";

function resolveMigrationsDir(): string {
  // Tests can override the location.
  const configured = process.env["MEMORY_MIGRATIONS_DIR"];
  if (typeof configured === "string" && configured.trim().length > 0) {
    return path.resolve(configured);
  }

  const locations = [
    path.join(process.cwd(), "src", "memory", "db", "migrations"),
    path.join(process.cwd(), "src", "lib", "db", "migrations"), // fallback
  ];
  for (const loc of locations) {
    if (fs.existsSync(loc)) return loc;
  }

  // Fallback: walk up from this module.
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    let cur = here;
    while (cur !== path.dirname(cur)) {
      const candidate = path.join(cur, "migrations");
      if (fs.existsSync(candidate)) return candidate;
      cur = path.dirname(cur);
    }
  } catch {
    /* ignore */
  }
  throw new Error("[memory.db] Could not resolve migrations directory. Set MEMORY_MIGRATIONS_DIR.");
}

function listMigrationFiles(): Array<{ version: string; name: string; fullPath: string }> {
  const dir = resolveMigrationsDir();
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const out: Array<{ version: string; name: string; fullPath: string }> = [];
  for (const f of files) {
    const match = f.match(/^(\d+)_(.+)\.sql$/);
    if (!match) continue;
    out.push({ version: match[1], name: match[2], fullPath: path.join(dir, f) });
  }
  return out;
}

function ensureMigrationsTable(db: SqliteAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _memory_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function getAppliedVersions(db: SqliteAdapter): Set<string> {
  const rows = db.prepare("SELECT version FROM _memory_migrations").all() as Array<{
    version: string;
  }>;
  return new Set(rows.map((r) => r.version));
}

function isSchemaAlreadyApplied(
  db: SqliteAdapter,
  migration: { version: string; name: string }
): boolean {
  // Custom idempotency guards for migrations whose CREATE TABLE IF NOT EXISTS
  // is not enough to short-circuit (e.g. backfill UPDATEs).
  switch (migration.name) {
    case "memory_l0_initial":
      return hasTable(db, "l0_messages");
    case "memory_l1_initial":
      return hasTable(db, "l1_memories");
    case "memory_l2_initial":
      return hasTable(db, "l2_scenes");
    case "memory_l3_initial":
      return hasTable(db, "l3_personas");
    case "memory_ops_initial":
      return (
        hasTable(db, "task_queue") &&
        hasTable(db, "task_lock") &&
        hasTable(db, "memory_settings") &&
        hasTable(db, "embedding_meta")
      );
    case "distillation_store":
      return (
        hasTable(db, "task_queue") &&
        hasTable(db, "task_lock") &&
        hasTable(db, "task_dlq") &&
        hasTable(db, "distillation_usage")
      );
    case "distillation_idempotency":
      return hasColumn(db, "task_queue", "idempotency_key");
    case "distillation_apply":
      return (
        hasColumn(db, "l1_memories", "pipeline_key") && hasColumn(db, "task_queue", "coalesce_key")
      );
    case "distillation_usage_idempotency":
      return hasIndex(db, "idx_distillation_usage_task");
    case "l0_capture_telemetry":
      return hasTable(db, "l0_capture_telemetry");
    default:
      return false;
  }
}

function hasColumn(db: SqliteAdapter, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === columnName);
}

function hasIndex(db: SqliteAdapter, indexName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(indexName) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function hasTable(db: SqliteAdapter, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
    .get(tableName) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function runMemoryMigrations(db: SqliteAdapter): void {
  ensureMigrationsTable(db);
  const applied = getAppliedVersions(db);
  const files = listMigrationFiles();

  for (const file of files) {
    if (applied.has(file.version)) {
      if (isSchemaAlreadyApplied(db, file)) continue;
      // version marked applied but schema missing — log a warning and re-run
      // (e.g. partial previous run on a fresh file)
    }
    const sql = fs.readFileSync(file.fullPath, "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT OR IGNORE INTO _memory_migrations (version, name) VALUES (?, ?)").run(
        file.version,
        file.name
      );
    })();
  }
}
