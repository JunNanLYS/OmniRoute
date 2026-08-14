/**
 * Recall budget helpers (RRF fusion + per-line char truncation) — adapted
 * from TencentDB Agent Memory (MIT).
 *
 * Upstream sources:
 *   MemoryCore/src/core/store/search-utils.ts
 *     (RRF_K = 60, rrfMerge, rrfScore)
 *   MemoryCore/src/core/hooks/auto-recall.ts
 *     (applyRecallBudget, normalizeBudgetLimit, truncateRecallLine,
 *      RECALL_TRUNCATION_SUFFIX, MIN_TRUNCATED_RECALL_LINE_CHARS)
 *
 * Local adaptation:
 *   - `rrfMerge` is generalized to any `getId` selector (upstream uses
 *     `record_id`). Default k=60 matches the RRF paper.
 *   - `applyRecallBudget` enforces both `maxCharsPerMemory` and
 *     `maxTotalRecallChars`, tracking truncated/dropped counts.
 *   - `truncateRecallLine` counts by Unicode code point (not UTF-16 units)
 *     so a cut never lands between surrogate halves.
 *   - `RECALL_TRUNCATION_SUFFIX` is Chinese but is preserved verbatim — it
 *     is a stable UX signal in the LLM-facing output.
 *
 * Source commit: fe3230f Update package.json (TencentDB Agent Memory, MIT)
 *
 * ADAPTED FROM TencentDB Agent Memory (MIT). Copyright (C) 2026 Tencent.
 */

/** Standard RRF constant from the original RRF paper. Higher k → smoother distribution. */
export const RRF_K = 60;

/** Truncation suffix appended to a recalled memory line when it was clipped. */
export const RECALL_TRUNCATION_SUFFIX =
  "…（已截断；可用 tdai_memory_search 或 tdai_conversation_search 查看详情）";

/** Minimum chars needed to keep a memory line (after per-line truncation) before dropping. */
export const MIN_TRUNCATED_RECALL_LINE_CHARS = 40;

/** Separator used between recalled lines. */
export const RECALL_LINE_SEPARATOR = "\n";

/** Default per-memory char budget. Mirrors upstream cfg.recall.maxCharsPerMemory. */
export const DEFAULT_MAX_CHARS_PER_MEMORY = 600;

/**
 * Merge multiple ranked lists via Reciprocal Rank Fusion.
 *
 * Each item's RRF score = sum over all lists of 1/(k + rank + 1).
 * Items appearing in multiple lists get their scores summed.
 *
 * @param lists   Array of ranked lists. Each item must have an id selectable by `getId`.
 * @param getId   Selector returning the dedup id of each item.
 * @param k       RRF constant (default 60).
 */
export function rrfMerge<T>(
  lists: T[][],
  getId: (item: T) => string,
  k: number = RRF_K
): Array<T & { rrfScore: number }> {
  const map = new Map<string, { item: T; rrfScore: number }>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const id = getId(item);
      const score = 1 / (k + rank + 1);
      const existing = map.get(id);
      if (existing) {
        existing.rrfScore += score;
      } else {
        map.set(id, { item, rrfScore: score });
      }
    }
  }

  return [...map.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(({ item, rrfScore }) => ({ ...item, rrfScore }));
}

export interface RecallBudgetLimits {
  /** Max chars per memory line. */
  maxCharsPerMemory?: number;
  /** Max total chars across all memory lines in the budget. */
  maxTotalRecallChars?: number;
}

export interface RecallBudgetResult {
  /** Lines that fit in the budget. */
  lines: string[];
  /** Number of lines whose content was clipped. */
  truncatedCount: number;
  /** Number of lines dropped because they did not fit. */
  droppedCount: number;
}

function normalizeBudgetLimit(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function truncateRecallLine(line: string, maxChars: number): string {
  // Count by code point so a cut never lands between surrogate halves.
  const cps = Array.from(line);
  if (cps.length <= maxChars) return line;
  if (maxChars <= RECALL_TRUNCATION_SUFFIX.length) {
    return cps.slice(0, maxChars).join("");
  }
  return `${cps
    .slice(0, maxChars - RECALL_TRUNCATION_SUFFIX.length)
    .join("")
    .trimEnd()}${RECALL_TRUNCATION_SUFFIX}`;
}

/**
 * Apply recall char-budget to a list of formatted memory lines.
 *
 *  - First, each line is clipped to `maxCharsPerMemory` (with truncation
 *    suffix when shortened).
 *  - Then, lines are accumulated against `maxTotalRecallChars`, skipping
 *    lines that don't fit and dropping the remainder.
 *  - Lines that survive clipping to `maxCharsPerMemory` but then must be
 *    clipped further to fit `maxTotalRecallChars` are counted as truncated.
 *
 * `truncatedCount` + `droppedCount` are exposed so the caller can log or
 * report the budget outcome.
 */
export function applyRecallBudget(lines: string[], limits: RecallBudgetLimits): RecallBudgetResult {
  const maxCharsPerMemory = normalizeBudgetLimit(limits.maxCharsPerMemory);
  const maxTotalRecallChars = normalizeBudgetLimit(limits.maxTotalRecallChars);

  if (!maxCharsPerMemory && !maxTotalRecallChars) {
    return { lines: [...lines], truncatedCount: 0, droppedCount: 0 };
  }

  const budgeted: string[] = [];
  let usedChars = 0;
  let truncatedCount = 0;
  let droppedCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const perMemoryBounded = maxCharsPerMemory ? truncateRecallLine(line, maxCharsPerMemory) : line;
    let wasTruncated = perMemoryBounded !== line;

    if (!maxTotalRecallChars) {
      budgeted.push(perMemoryBounded);
      if (wasTruncated) truncatedCount++;
      continue;
    }

    const separatorChars = budgeted.length > 0 ? RECALL_LINE_SEPARATOR.length : 0;
    const remainingChars = maxTotalRecallChars - usedChars - separatorChars;
    if (remainingChars <= 0) {
      droppedCount += lines.length - i;
      break;
    }

    if (perMemoryBounded.length > remainingChars) {
      const canFit = remainingChars >= MIN_TRUNCATED_RECALL_LINE_CHARS;
      if (canFit) {
        const totalBounded = truncateRecallLine(perMemoryBounded, remainingChars);
        budgeted.push(totalBounded);
        usedChars += separatorChars + totalBounded.length;
        wasTruncated ||= totalBounded !== perMemoryBounded;
        if (wasTruncated) truncatedCount++;
      }
      droppedCount += lines.length - i - (canFit ? 1 : 0);
      break;
    }

    budgeted.push(perMemoryBounded);
    usedChars += separatorChars + perMemoryBounded.length;
    if (wasTruncated) truncatedCount++;
  }

  return { lines: budgeted, truncatedCount, droppedCount };
}

/**
 * Convenience helper that derives the total recall-char budget from per-memory
 * and total limits. Mirrors the upstream "600 chars/memory, derived total".
 *
 * Useful when callers have per-memory limits but want a reasonable total cap.
 */
export function deriveTotalRecallBudget(
  maxCharsPerMemory: number | undefined,
  memoryCount: number
): number | undefined {
  if (maxCharsPerMemory == null || memoryCount <= 0) return undefined;
  return maxCharsPerMemory * memoryCount;
}
