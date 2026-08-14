/**
 * Tests for recall budget (RRF + char truncation) — `src/memory/tencent/recall/budget.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  rrfMerge,
  RRF_K,
  applyRecallBudget,
  DEFAULT_MAX_CHARS_PER_MEMORY,
  deriveTotalRecallBudget,
  RECALL_TRUNCATION_SUFFIX,
} from "../../../../src/memory/tencent/index.js";

describe("rrfMerge", () => {
  it("merges two lists with the standard RRF k=60", () => {
    const a = [{ record_id: "x" }, { record_id: "y" }];
    const b = [{ record_id: "y" }, { record_id: "z" }];
    const merged = rrfMerge([a, b], (x) => x.record_id as string);
    const map = new Map(merged.map((m) => [m.record_id, m.rrfScore]));

    // x appears at rank 0 in list a → 1/(60+0+1) = 1/61
    // y appears at rank 1 in a + rank 0 in b → 1/62 + 1/61
    // z appears at rank 1 in b → 1/62
    assert.ok(Math.abs(map.get("x")! - 1 / 61) < 1e-9);
    assert.ok(Math.abs(map.get("z")! - 1 / 62) < 1e-9);
    assert.ok(map.get("y")! > map.get("x")!); // y wins on combined rank
  });

  it("returns items sorted by descending rrfScore", () => {
    // mid appears in BOTH lists → highest score.
    // top1 appears at rank 0 in a only → score 1/61.
    // top2 appears at rank 0 in b only → score 1/61 (same as top1, but appears later in insertion).
    // bottom appears only at rank 1 in a → score 1/62 → lowest.
    const a = [{ id: "top1" }, { id: "mid" }, { id: "bottom" }];
    const b = [{ id: "top2" }, { id: "mid" }];
    const merged = rrfMerge([a, b], (x) => x.id as string);
    assert.equal(merged[0]!.id, "mid");
    // bottom (1/62) is the lowest-scoring entry.
    assert.equal(merged[merged.length - 1]!.id, "bottom");
    // mid > {top1, top2, bottom}.
    assert.ok(
      merged.find((m) => m.id === "mid")!.rrfScore > merged.find((m) => m.id === "top1")!.rrfScore
    );
    assert.ok(
      merged.find((m) => m.id === "mid")!.rrfScore > merged.find((m) => m.id === "bottom")!.rrfScore
    );
  });

  it("uses k=60 by default (RRF_K constant)", () => {
    assert.equal(RRF_K, 60);
    const merged = rrfMerge([[{ id: "x" }]], (x) => x.id as string);
    assert.equal(merged[0]!.rrfScore, 1 / 61);
  });

  it("accepts a custom k", () => {
    const merged = rrfMerge([[{ id: "x" }]], (x) => x.id as string, 10);
    assert.equal(merged[0]!.rrfScore, 1 / 11);
  });

  it("returns [] for empty input", () => {
    assert.deepEqual(
      rrfMerge([], (x) => x as unknown as string),
      []
    );
  });
});

describe("applyRecallBudget", () => {
  it("returns lines unchanged when no limits are set", () => {
    const lines = ["a", "b", "c"];
    const out = applyRecallBudget(lines, {});
    assert.deepEqual(out.lines, lines);
    assert.equal(out.truncatedCount, 0);
    assert.equal(out.droppedCount, 0);
  });

  it("truncates each line to maxCharsPerMemory", () => {
    const lines = ["x".repeat(2000), "y".repeat(2000)];
    const out = applyRecallBudget(lines, { maxCharsPerMemory: 100 });
    assert.equal(out.lines.length, 2);
    assert.ok(out.lines[0]!.endsWith(RECALL_TRUNCATION_SUFFIX));
    assert.ok(out.lines[0]!.length <= 100);
    assert.equal(out.truncatedCount, 2);
    assert.equal(out.droppedCount, 0);
  });

  it("truncates by codepoint (no surrogate-half corruption)", () => {
    // U+1F600 (😀) is a surrogate pair in UTF-16
    const line = "😀".repeat(100);
    const out = applyRecallBudget([line], { maxCharsPerMemory: 5 });
    // Must not contain U+FFFD (replacement char)
    assert.ok(!out.lines[0]!.includes("�"));
  });

  it("drops lines that exceed maxTotalRecallChars", () => {
    const lines = ["x".repeat(50), "y".repeat(50), "z".repeat(50)];
    const out = applyRecallBudget(lines, { maxTotalRecallChars: 100 });
    // 2 lines of 50 chars + 1 newline = 101 → keep 2, drop 1
    assert.ok(out.lines.length <= 2, `expected <= 2 lines, got ${out.lines.length}`);
    assert.ok(out.droppedCount >= 1 || out.truncatedCount >= 1);
  });

  it("respects MIN_TRUNCATED_RECALL_LINE_CHARS for the last-fit case", () => {
    const lines = ["a".repeat(60), "b".repeat(60)];
    const out = applyRecallBudget(lines, { maxTotalRecallChars: 65 });
    // 60 + 1 sep = 61 → second line has only 4 chars remaining (< MIN=40) → dropped entirely
    assert.equal(out.lines.length, 1);
    assert.equal(out.droppedCount, 1);
  });

  it("ignores non-positive limits", () => {
    const lines = ["a", "b"];
    const out = applyRecallBudget(lines, { maxCharsPerMemory: -1, maxTotalRecallChars: 0 });
    assert.deepEqual(out.lines, lines);
  });

  it("default per-memory budget is 600 chars", () => {
    assert.equal(DEFAULT_MAX_CHARS_PER_MEMORY, 600);
  });
});

describe("deriveTotalRecallBudget", () => {
  it("multiplies per-memory by count", () => {
    assert.equal(deriveTotalRecallBudget(600, 3), 1800);
  });

  it("returns undefined for missing / invalid inputs", () => {
    assert.equal(deriveTotalRecallBudget(undefined, 3), undefined);
    assert.equal(deriveTotalRecallBudget(600, 0), undefined);
    assert.equal(deriveTotalRecallBudget(600, -1), undefined);
  });
});
