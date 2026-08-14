/**
 * Retention repository — owns the SQL that the retention cleaner calls.
 *
 * Keeping DELETE statements inside `src/memory/db/repositories/` enforces the
 * hard rule "no raw SQL outside `src/memory/db/`". The cleaner orchestrates
 * scheduling and lifecycle; this repository owns the persistence contract.
 */
import type { RunResult } from "@/lib/db/adapters/types";

import { getMemoryDbInstance } from "../core.ts";

export interface RetentionCleanupOptions {
  now: number;
  /** ISO timestamp used as `<` comparison. Default = `now` (epoch ms). */
  l0CutoffIso?: string;
  l1CutoffIso?: string;
}

export interface RetentionCleanupResult {
  deletedL0Messages: number;
  deletedL1Memories: number;
  deletedL1Versions: number;
}

function changes(result: RunResult): number {
  return Number.isFinite(result.changes) ? result.changes : 0;
}

export function runRetentionCleanup(
  options: RetentionCleanupOptions & { l0Days: number | null; l1Days: number | null }
): RetentionCleanupResult {
  const db = getMemoryDbInstance();
  let deletedL0Messages = 0;
  let deletedL1Memories = 0;
  let deletedL1Versions = 0;

  db.transaction(() => {
    if (options.l0Days !== null) {
      const cutoff =
        options.l0CutoffIso ?? new Date(options.now - options.l0Days * 86_400_000).toISOString();
      deletedL0Messages = changes(
        db.prepare("DELETE FROM l0_messages WHERE recorded_at < ?").run(cutoff)
      );
    }

    if (options.l1Days !== null) {
      const cutoff =
        options.l1CutoffIso ?? new Date(options.now - options.l1Days * 86_400_000).toISOString();
      const expired = db
        .prepare(
          `SELECT id, owner_key
           FROM l1_memories
           GROUP BY id, owner_key
           HAVING MAX(updated_at) < ?`
        )
        .all(cutoff) as Array<{ id: string; owner_key: string }>;
      const deleteHistory = db.prepare("DELETE FROM l1_memories WHERE id = ? AND owner_key = ?");
      for (const memory of expired) {
        deletedL1Versions += changes(deleteHistory.run(memory.id, memory.owner_key));
      }
      deletedL1Memories = expired.length;
    }
  })();

  return { deletedL0Messages, deletedL1Memories, deletedL1Versions };
}
