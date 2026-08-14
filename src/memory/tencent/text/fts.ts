/**
 * FTS5 query/tokenize helpers — reimplemented from scratch.
 *
 * The original upstream referenced an `openclaw core hybrid.ts` whose license
 * could not be independently verified inside this repository (no source file
 * present, no LICENSE). To stay safe, this module reimplements the small
 * normalization/tokenization pieces from scratch with the same observable
 * behavior (token set + FTS5 MATCH output shape) as the TencentDB adapter.
 *
 * Behavior parity targets:
 *   - `normalizeFtsTokens`  → word-bounded Unicode token stream (fallback when
 *                             no jieba is available)
 *   - `buildFtsQuery`       → quoted OR-joined tokens, suitable as an
 *                             `fts5 MATCH` operand
 *   - `tokenizeForFts`      → space-joined tokens for the FTS5 content column
 *   - `bm25RankToScore`     → [0, 1] score from BM25 rank
 *   - `ZH_STOP_WORDS`       → small Chinese stop-word set used to suppress
 *                             noise during tokenization
 *
 * Source commit: fe3230f Update package.json (TencentDB Agent Memory, MIT)
 *
 * REIMPLEMENTED — no upstream code is copied. Behavior was derived from the
 * public function signatures and the surrounding usage examples in
 * MemoryCore/src/core/store/sqlite.ts (Copyright (C) 2026 Tencent, MIT).
 */

/** Chinese stop-words kept small on purpose — only high-frequency function words. */
export const ZH_STOP_WORDS: ReadonlySet<string> = new Set([
  "的",
  "了",
  "在",
  "是",
  "我",
  "有",
  "和",
  "就",
  "不",
  "人",
  "都",
  "一",
  "一个",
  "上",
  "也",
  "很",
  "到",
  "说",
  "要",
  "去",
  "你",
  "会",
  "着",
  "没有",
  "看",
  "好",
  "自己",
  "这",
  "他",
  "她",
  "它",
  "们",
  "那",
  "吗",
  "吧",
  "呢",
  "啊",
  "呀",
  "哦",
  "嗯",
]);

/** Word-character class used by the fallback regex. Mirrors upstream `/[\p{L}\p{N}_]+/gu`. */
const WORD_RE = /[\p{L}\p{N}_]+/gu;

/** A pluggable segmenter interface (e.g. jieba `cutForSearch`). */
export interface Segmenter {
  /** Returns the search-mode tokenization of `text`. */
  cutForSearch(text: string): string[];
}

/**
 * Normalize raw text into a deduplicated token stream.
 *
 * - Optional segmenter: if provided, tokens are filtered through ZH_STOP_WORDS.
 * - Otherwise falls back to a Unicode regex split.
 * - Pure whitespace / punctuation tokens are always removed.
 * - Returned tokens are unique.
 */
export function normalizeFtsTokens(raw: string, segmenter: Segmenter | null = null): string[] {
  if (!raw) return [];

  let tokens: string[];
  if (segmenter) {
    tokens = segmenter
      .cutForSearch(raw)
      .map((t) => t.trim())
      .filter((t) => {
        if (!t) return false;
        if (!/[\p{L}\p{N}]/u.test(t)) return false;
        if (ZH_STOP_WORDS.has(t)) return false;
        return true;
      });
  } else {
    tokens =
      raw
        .match(WORD_RE)
        ?.map((t) => t.trim())
        .filter(Boolean) ?? [];
  }

  // dedup, preserving insertion order
  return [...new Set(tokens)];
}

/**
 * Build an FTS5 MATCH query string.
 *
 * Tokens are OR-joined as quoted phrase terms so a document matching *any*
 * token is returned. BM25 naturally ranks documents that match more tokens
 * higher, so precision is preserved while recall is significantly improved.
 *
 * Returns `null` if no usable tokens are found.
 *
 * Example (fallback): "旅行计划 API" → '"旅行计划" OR "API"'
 */
export function buildFtsQuery(raw: string, segmenter: Segmenter | null = null): string | null {
  const tokens = normalizeFtsTokens(raw, segmenter);
  if (tokens.length === 0) return null;
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" OR ");
}

/**
 * Tokenize text for FTS5 indexing (write-side).
 *
 * Returns a space-joined string suitable for storing in an FTS5 `content`
 * column whose tokenizer is `unicode61` (the default). When no segmenter is
 * provided, the original text is returned unchanged — the unicode61
 * tokenizer will still split it on word boundaries.
 *
 * Example (fallback): "用户五月去日本旅行" → "用户五月去日本旅行" (unchanged)
 */
export function tokenizeForFts(raw: string, segmenter: Segmenter | null = null): string {
  if (!raw) return "";
  if (!segmenter) return raw;
  return segmenter.cutForSearch(raw).join(" ");
}

/**
 * Convert a BM25 rank (negative = more relevant) to a 0–1 score.
 *
 * Mirrors the formula in the upstream sqlite.ts helper:
 *   - Non-finite ranks → a small constant (~1e-3)
 *   - Negative ranks → |rank| / (1 + |rank|)
 *   - Non-negative ranks → 1 / (1 + rank)
 */
export function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) return 1 / (1 + 999);
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}
