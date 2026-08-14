/**
 * Tests for head/tail extraction chunking — `src/memory/tencent/text/chunking.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  applyOversizeStrategy,
  DEFAULT_OVERSIZE_OPTIONS,
} from "../../../../src/memory/tencent/index.js";

describe("applyOversizeStrategy", () => {
  it("passes through when total size <= chunkMaxBytes", () => {
    const small = [{ role: "user", content: "hello" }];
    const r = applyOversizeStrategy(small);
    assert.equal(r.truncated, false);
    assert.equal(r.omittedMessageCount, 0);
    assert.deepEqual(r.messages, small);
  });

  it("returns empty result for empty input", () => {
    const r = applyOversizeStrategy([]);
    assert.equal(r.truncated, false);
    assert.equal(r.messages.length, 0);
  });

  it("truncates a chunk that exceeds the budget and emits a placeholder", () => {
    // Make a chunk that is way over 80KB so truncation triggers.
    const big = "x".repeat(50_000);
    const messages = [
      { role: "user", content: big },
      { role: "assistant", content: big },
      { role: "user", content: big },
      { role: "assistant", content: big },
    ];
    const r = applyOversizeStrategy(messages);
    assert.equal(r.truncated, true);
    assert.ok(r.omittedMessageCount > 0, "expected some messages omitted");

    // Placeholder in the middle (role=system)
    const placeholder = r.messages.find((m) => m.role === "system");
    assert.ok(placeholder, "expected a system placeholder");
    assert.match(placeholder!.content, /中间 \d+ 条消息/);
  });

  it("keeps at least 1 head and 1 tail message even when single message exceeds headKeep", () => {
    const huge = { role: "user", content: "x".repeat(50_000) }; // 50KB > default headKeepBytes (20KB)
    const other = { role: "assistant", content: "short" };
    const huge2 = { role: "user", content: "x".repeat(50_000) };
    const r = applyOversizeStrategy([huge, other, huge2], {
      chunkMaxBytes: 1024, // force extreme truncation
      headKeepBytes: 10,
      tailKeepBytes: 10,
    });
    // pathological: head + tail must each keep at least 1 message even when
    // single messages exceed the headKeep / tailKeep budget.
    // Tail walks backwards from messages.length-1, so it picks up huge2 (the last message)
    // and omits `other` in between. Head picks up huge.
    const user = r.messages.filter((m) => m.role === "user");
    assert.ok(user.length >= 1, "at least 1 user message kept");
    // omitted slice must contain at least 1 entry (other) — and a placeholder appears
    assert.ok(r.truncated, "truncated flag set");
    assert.ok(r.omittedMessageCount >= 1, "at least 1 message omitted");
  });

  it("passthrough when head+tail cover everything (omitted=0)", () => {
    const huge = { role: "user", content: "x".repeat(40_000) }; // < headKeepBytes*2
    const r = applyOversizeStrategy([huge, huge], {
      chunkMaxBytes: 1024,
      headKeepBytes: 50_000,
      tailKeepBytes: 50_000,
    });
    // Head + tail swallow the chunk fully → no real omission → passthrough
    assert.equal(r.truncated, false);
    assert.equal(r.omittedMessageCount, 0);
  });

  it("respects default options constants", () => {
    assert.equal(DEFAULT_OVERSIZE_OPTIONS.chunkMaxBytes, 81_920);
    assert.equal(DEFAULT_OVERSIZE_OPTIONS.headKeepBytes, 20_480);
    assert.equal(DEFAULT_OVERSIZE_OPTIONS.tailKeepBytes, 20_480);
  });
});
