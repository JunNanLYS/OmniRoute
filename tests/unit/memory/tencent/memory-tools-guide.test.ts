/**
 * Tests for memory tools guide + per-turn budget — `src/memory/tencent/recall/memory-tools-guide.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildMemoryToolsGuide,
  MemoryToolCallBudget,
  MEMORY_TOOLS_PER_TURN_LIMIT,
  MEMORY_TOOLS_GUIDE_OPEN,
  MEMORY_TOOLS_GUIDE_CLOSE,
  TOOL_MEMORY_SEARCH,
  TOOL_CONVERSATION_SEARCH,
} from "../../../../src/memory/tencent/index.js";

describe("buildMemoryToolsGuide", () => {
  it("wraps the guide in <memory-tools-guide> tags", () => {
    const g = buildMemoryToolsGuide();
    assert.ok(g.startsWith(MEMORY_TOOLS_GUIDE_OPEN));
    assert.ok(g.endsWith(MEMORY_TOOLS_GUIDE_CLOSE));
  });

  it("exposes both tool names + the per-turn ≤3 semantic", () => {
    const g = buildMemoryToolsGuide();
    assert.ok(g.includes(TOOL_MEMORY_SEARCH));
    assert.ok(g.includes(TOOL_CONVERSATION_SEARCH));
    assert.ok(g.includes(`合计最多调用 ${MEMORY_TOOLS_PER_TURN_LIMIT} 次`));
  });
});

describe("MemoryToolCallBudget", () => {
  it("starts with 0 calls used", () => {
    const b = new MemoryToolCallBudget();
    assert.equal(b.used, 0);
    assert.equal(b.remaining(), 3);
    assert.equal(b.canCall(), true);
  });

  it("consumes calls until exhausted, then refuses further calls", () => {
    const b = new MemoryToolCallBudget();
    assert.equal(b.consume(), true);
    assert.equal(b.consume(), true);
    assert.equal(b.consume(), true);
    assert.equal(b.consume(), false); // 4th call refused
    assert.equal(b.canCall(), false);
    assert.equal(b.remaining(), 0);
  });

  it("resets for a new turn", () => {
    const b = new MemoryToolCallBudget();
    b.consume();
    b.consume();
    b.reset();
    assert.equal(b.used, 0);
    assert.equal(b.canCall(), true);
  });

  it("supports a custom limit", () => {
    const b = new MemoryToolCallBudget(5);
    assert.equal(b.remaining(), 5);
  });

  it("MEMORY_TOOLS_PER_TURN_LIMIT is 3 (combined semantic)", () => {
    assert.equal(MEMORY_TOOLS_PER_TURN_LIMIT, 3);
  });
});
