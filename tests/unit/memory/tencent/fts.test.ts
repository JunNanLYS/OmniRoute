/**
 * Tests for FTS5 query + tokenize + BM25 helpers — `src/memory/tencent/text/fts.ts`.
 *
 * These helpers are reimplemented from scratch (no upstream code copied);
 * see THIRD_PARTY_NOTICES.md.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildFtsQuery,
  tokenizeForFts,
  bm25RankToScore,
  normalizeFtsTokens,
  ZH_STOP_WORDS,
} from "../../../../src/memory/tencent/index.js";

describe("normalizeFtsTokens (fallback)", () => {
  it("splits Chinese + Latin into tokens", () => {
    const tokens = normalizeFtsTokens("旅行计划 API", null);
    assert.ok(tokens.includes("旅行计划"));
    assert.ok(tokens.includes("API"));
  });

  it("deduplicates repeated tokens", () => {
    const tokens = normalizeFtsTokens("foo bar foo baz", null);
    assert.deepEqual(tokens, ["foo", "bar", "baz"]);
  });

  it("drops pure-whitespace / punctuation tokens", () => {
    const tokens = normalizeFtsTokens("  hello   world  !!! ", null);
    assert.deepEqual(tokens, ["hello", "world"]);
  });

  it("returns [] for empty / whitespace input", () => {
    assert.deepEqual(normalizeFtsTokens("", null), []);
    assert.deepEqual(normalizeFtsTokens("   \n\t  ", null), []);
  });
});

describe("normalizeFtsTokens (segmenter)", () => {
  it("filters Chinese stop-words and deduplicates", () => {
    // Use a word-level fake segmenter to mimic jieba's actual cut-for-search output.
    const fakeSegmenter = { cutForSearch: (t: string) => t.split(/\s+/) };
    const tokens = normalizeFtsTokens("我的 用户 的 喜欢 编程", fakeSegmenter);
    // "的" is in the stop-word list; "我的" is not (the upstream list is short and single-char).
    assert.ok(!tokens.includes("的"));
    assert.ok(tokens.includes("我的"));
    assert.ok(tokens.includes("用户"));
    assert.ok(tokens.includes("喜欢"));
    assert.ok(tokens.includes("编程"));
  });

  it("filters single-char stop-words when segmenter splits per character", () => {
    const fakeSegmenter = { cutForSearch: (t: string) => t.split("") };
    const tokens = normalizeFtsTokens("我的用户喜欢编程", fakeSegmenter);
    assert.ok(!tokens.includes("的"));
    assert.ok(!tokens.includes("我"));
    // multi-char tokens like 用户 are not produced by this segmenter; "用" and "户" remain
    assert.ok(tokens.includes("用"));
    assert.ok(tokens.includes("户"));
  });
});

describe("buildFtsQuery", () => {
  it("returns null for empty / no-token input", () => {
    assert.equal(buildFtsQuery("", null), null);
    assert.equal(buildFtsQuery("   ", null), null);
  });

  it("quotes tokens and OR-joins them", () => {
    const q = buildFtsQuery("旅行计划 API", null);
    assert.equal(q, '"旅行计划" OR "API"');
  });

  it("handles embedded double-quotes gracefully (tokens split at quote)", () => {
    // The fallback regex splitter breaks at `"`, so each piece becomes its own token
    // and each token is independently quoted in the MATCH expression.
    const q = buildFtsQuery('foo"bar baz', null);
    assert.equal(q, '"foo" OR "bar" OR "baz"');
  });
});

describe("tokenizeForFts", () => {
  it("passes through unchanged when no segmenter is given", () => {
    assert.equal(tokenizeForFts("用户五月去日本旅行", null), "用户五月去日本旅行");
  });

  it("joins segmenter tokens with spaces", () => {
    const fakeSegmenter = { cutForSearch: (t: string) => t.split(" ") };
    assert.equal(tokenizeForFts("foo bar baz", fakeSegmenter), "foo bar baz");
  });

  it("returns empty string for empty input", () => {
    assert.equal(tokenizeForFts("", null), "");
  });
});

describe("bm25RankToScore", () => {
  it("clamps to small constant for non-finite rank", () => {
    const s = bm25RankToScore(Number.NaN);
    assert.ok(s > 0 && s < 0.01);
  });

  it("higher relevance (more negative rank) → higher score", () => {
    const s1 = bm25RankToScore(-5);
    const s2 = bm25RankToScore(-0.5);
    assert.ok(s1 > s2, `expected s1 > s2, got ${s1} vs ${s2}`);
  });

  it("positive ranks produce small scores", () => {
    const s = bm25RankToScore(100);
    assert.ok(s > 0 && s < 0.02);
  });

  it("score is always in [0, 1]", () => {
    for (const r of [-1000, -1, 0, 1, 1000]) {
      const s = bm25RankToScore(r);
      assert.ok(s >= 0 && s <= 1, `rank=${r} score=${s} out of bounds`);
    }
  });
});

describe("ZH_STOP_WORDS", () => {
  it("is a non-empty Set", () => {
    assert.ok(ZH_STOP_WORDS.size > 0);
    assert.ok(ZH_STOP_WORDS.has("的"));
    assert.ok(ZH_STOP_WORDS.has("了"));
    assert.ok(!ZH_STOP_WORDS.has("用户")); // not a stop-word
  });
});
