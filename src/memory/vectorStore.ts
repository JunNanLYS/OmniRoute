/**
 * src/memory/vectorStore.ts
 *
 * Memory vector store — best-effort / degradable.
 *
 * Public contract (MemoryVectorStore in types.ts) is implemented lazily:
 *   - getMemoryVectorStore() returns the singleton, or null if sqlite-vec is
 *     unavailable (cloud/WASM) or VECTOR_STORE_DISABLE_VEC=true.
 *   - resetMemoryVectorStore() clears the cache (test seam).
 *
 * When null, callers must fall back to FTS5 retrieval. The FTS5 path is the
 * authoritative retrieval surface — it MUST always work, independent of this
 * store. See retrieval/rrf.ts for the pure fusion primitive.
 *
 * This store uses the standalone memory.db connection and never touches the
 * main application database.
 */

import { createRequire } from "node:module";
import type { MemoryVectorStore } from "./types.ts";
import { getMemoryDbInstance } from "./db/core.ts";

const _require = createRequire(import.meta.url);

let _instance: MemoryVectorStore | null | undefined = undefined;

export function getMemoryVectorStore(): MemoryVectorStore | null {
  if (_instance !== undefined) return _instance;

  if (process.env["VECTOR_STORE_DISABLE_VEC"] === "true") {
    _instance = null;
    return null;
  }

  const db = getMemoryDbInstance();
  const raw = (db as unknown as { raw?: { loadExtension?: (path: string) => void } }).raw;
  if (!raw || typeof raw.loadExtension !== "function") {
    _instance = null;
    return null;
  }

  // Lazy require — sqlite-vec is an optional native extension.
  let sqliteVec: { load: (db: unknown) => void } | null = null;
  try {
    sqliteVec = _require("sqlite-vec") as { load: (db: unknown) => void };
  } catch {
    sqliteVec = null;
  }
  if (!sqliteVec) {
    _instance = null;
    return null;
  }
  try {
    sqliteVec.load(raw);
  } catch {
    _instance = null;
    return null;
  }
  _instance = new BestEffortMemoryVectorStore();
  return _instance;
}

export function resetMemoryVectorStore(): void {
  _instance = undefined;
}

class BestEffortMemoryVectorStore implements MemoryVectorStore {
  ensureReady(args: { signature: string; dim: number }): { ready: boolean; reason: string } {
    // Best-effort: ensure table exists; failures degrade to FTS5 only.
    const db = getMemoryDbInstance();
    try {
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(embedding float[${args.dim}])`
      );
      return { ready: true, reason: `memory_vec ensured dim=${args.dim}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ready: false, reason: `vec0 unavailable: ${msg.slice(0, 200)}` };
    }
  }

  upsertVector(args: { rowid: number; vector: Float32Array }): void {
    const db = getMemoryDbInstance();
    // vec0 v0.1.9 requires BigInt for explicit rowid — plain numbers rejected.
    db.prepare("DELETE FROM memory_vec WHERE rowid = ?").run(BigInt(args.rowid));
    db.prepare("INSERT INTO memory_vec(rowid, embedding) VALUES (?, ?)").run(
      BigInt(args.rowid),
      Buffer.from(args.vector.buffer, args.vector.byteOffset, args.vector.byteLength)
    );
  }

  deleteVector(args: { rowid: number }): void {
    const db = getMemoryDbInstance();
    db.prepare("DELETE FROM memory_vec WHERE rowid = ?").run(BigInt(args.rowid));
  }

  searchVector(args: {
    vector: Float32Array;
    topK: number;
    ownerKey: string;
  }): Array<{ rowid: number; distance: number; score: number }> {
    const db = getMemoryDbInstance();
    const k = args.topK > 0 ? args.topK : 10;
    const blob = Buffer.from(args.vector.buffer, args.vector.byteOffset, args.vector.byteLength);
    const rows = db
      .prepare(
        `SELECT rowid, distance
         FROM memory_vec
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance ASC`
      )
      .all(blob, k) as Array<{ rowid: number; distance: number }>;
    return rows.map((r) => ({
      rowid: Number(r.rowid),
      distance: r.distance,
      score: 1 / (1 + r.distance),
    }));
  }
}
