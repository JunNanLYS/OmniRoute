/**
 * src/memory/retrieval/rrf.ts
 *
 * Reciprocal Rank Fusion (RRF) — pure, deterministic fusion of N ranked lists.
 * rrf_score(d) = sum(1 / (k + rank_i)) over each list i that contains d.
 *
 * k=60 is the canonical constant used in the literature (Cormack et al., 2009).
 *
 * Vectors are best-effort and may be disabled (VECTOR_STORE_DISABLE_VEC=true);
 * RRF must therefore work purely on FTS5-ranked inputs. This module deliberately
 * has zero dependencies on the vector store.
 */

export const RRF_K = 60;

export interface RankedItem {
  id: string;
  rank: number;
}

export interface FusedItem {
  id: string;
  score: number;
  ranks: number[];
}

export interface FuseOptions {
  k?: number;
}

export function fuseRankedLists(
  lists: Array<Array<{ id: string; rank: number }>>,
  opts: FuseOptions = {}
): FusedItem[] {
  const k = opts.k ?? RRF_K;
  if (k <= 0) {
    throw new Error(`[rrf] k must be > 0, got ${k}`);
  }
  const scoreById = new Map<string, { score: number; ranks: number[] }>();

  for (const list of lists) {
    for (const item of list) {
      if (!Number.isFinite(item.rank) || item.rank < 1) {
        throw new Error(`[rrf] ranks must be >= 1, got ${item.rank} for id=${item.id}`);
      }
      const entry = scoreById.get(item.id) ?? { score: 0, ranks: [] };
      entry.score += 1 / (k + item.rank);
      entry.ranks.push(item.rank);
      scoreById.set(item.id, entry);
    }
  }

  const out: FusedItem[] = [];
  for (const [id, v] of scoreById.entries()) {
    out.push({ id, score: v.score, ranks: v.ranks });
  }
  // Stable, deterministic ordering: by score desc, then by id asc.
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id.localeCompare(b.id);
  });
  return out;
}
