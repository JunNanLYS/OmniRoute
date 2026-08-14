/**
 * Unit tests for the 4-layer recall facade.
 *
 * Covers:
 *   - Stable system context (L3) + L2 nav + static tools guide always returned.
 *   - Dynamic L1 top-5 from the provider.
 *   - Timeout (default 5000ms) — structured failure swallowed.
 *   - L0 NEVER appears in any layer.
 *   - Tools guide includes the allowed tools (tdai_memory_search,
 *     tdai_conversation_search, read_file max 3) and the reference-only label.
 *   - L2 limit ≤15 enforced.
 *   - L1 limit ≤5 enforced.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  L2_NAV_LIMIT,
  L1_TOP_K,
  MEMORY_TOOLS_GUIDE,
  NOOP_RECALL_PROVIDER,
  recallLayeredContext,
  setRecallProvider,
  resetRecallProviderForTests,
  type RecallProvider,
} from "../../src/memory/recall/facade.ts";

describe("recall — L2/L1 hard limits", () => {
  it("L2_NAV_LIMIT is 15", () => {
    assert.equal(L2_NAV_LIMIT, 15);
  });
  it("L1_TOP_K is 5", () => {
    assert.equal(L1_TOP_K, 5);
  });
});

describe("recall — static tools guide", () => {
  it("contains the reference-only label", () => {
    assert.ok(MEMORY_TOOLS_GUIDE.includes("reference-only"));
  });
  it("names tdai_memory_search", () => {
    assert.ok(MEMORY_TOOLS_GUIDE.includes("tdai_memory_search"));
  });
  it("names tdai_conversation_search", () => {
    assert.ok(MEMORY_TOOLS_GUIDE.includes("tdai_conversation_search"));
  });
  it("names read_file with max-3 cap", () => {
    assert.ok(MEMORY_TOOLS_GUIDE.includes("read_file"));
    assert.ok(MEMORY_TOOLS_GUIDE.toLowerCase().includes("max 3"));
  });
  it("says it is NOT instructions", () => {
    assert.ok(/NOT instructions/i.test(MEMORY_TOOLS_GUIDE));
  });
});

describe("recall — facade layers", () => {
  it("returns the static tools guide even when no provider is set", async () => {
    resetRecallProviderForTests();
    const out = await recallLayeredContext(
      { ownerId: "k", sessionId: "s", query: "q" },
      { timeoutMs: 100 }
    );
    assert.equal(out.layers.toolsGuide, MEMORY_TOOLS_GUIDE);
    assert.equal(out.layers.l1.length, 0);
    assert.equal(out.layers.l2.length, 0);
    assert.equal(out.layers.l3.length, 0);
  });

  it("L3 returns from the provider verbatim", async () => {
    const provider: RecallProvider = {
      fetchL3: async () => [
        { id: "L3-1", title: "Project state", content: "We use Postgres" },
        { id: "L3-2", title: "Conventions", content: "Tab indent" },
      ],
      fetchL2: async () => [],
      fetchL1: async () => [],
    };
    setRecallProvider(provider);
    const out = await recallLayeredContext(
      { ownerId: "k", sessionId: "s", query: "q" },
      { timeoutMs: 100 }
    );
    assert.equal(out.layers.l3.length, 2);
    assert.equal(out.layers.l3[0].title, "Project state");
    assert.equal(out.l3Status, "ok");
    resetRecallProviderForTests();
  });

  it("L2 truncated to 15", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      id: `L2-${i}`,
      title: `t${i}`,
      summary: `s${i}`,
    }));
    const provider: RecallProvider = {
      fetchL3: async () => [],
      fetchL2: async () => many,
      fetchL1: async () => [],
    };
    setRecallProvider(provider);
    const out = await recallLayeredContext(
      { ownerId: "k", sessionId: "s", query: "q" },
      { timeoutMs: 100 }
    );
    assert.equal(out.layers.l2.length, 15);
    assert.equal(out.layers.l2[0].id, "L2-0");
    resetRecallProviderForTests();
  });

  it("L1 truncated to 5", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `L1-${i}`,
      content: `c${i}`,
      score: i,
      tags: [],
    }));
    const provider: RecallProvider = {
      fetchL3: async () => [],
      fetchL2: async () => [],
      fetchL1: async () => many,
    };
    setRecallProvider(provider);
    const out = await recallLayeredContext(
      { ownerId: "k", sessionId: "s", query: "q" },
      { timeoutMs: 100 }
    );
    assert.equal(out.layers.l1.length, 5);
    assert.equal(out.layers.l1[0].id, "L1-0");
    resetRecallProviderForTests();
  });

  it("L0 is never returned (no L0 layer exists)", async () => {
    const out = await recallLayeredContext(
      { ownerId: "k", sessionId: "s", query: "q" },
      { timeoutMs: 100 }
    );
    const keys = Object.keys(out.layers);
    assert.ok(!keys.includes("l0"));
    assert.deepEqual(keys.sort(), ["l1", "l2", "l3", "toolsGuide"].sort());
  });
});

describe("recall — structured timeout (no throw)", () => {
  it("does not throw on a slow provider — returns timeout status", async () => {
    const provider: RecallProvider = {
      fetchL3: async () => new Promise(() => {}),
      fetchL2: async () => new Promise(() => {}),
      fetchL1: async () => new Promise(() => {}),
    };
    setRecallProvider(provider);
    const out = await recallLayeredContext(
      { ownerId: "k", sessionId: "s", query: "q" },
      { timeoutMs: 25 }
    );
    assert.equal(out.l1Status, "timeout");
    assert.equal(out.l2Status, "timeout");
    assert.equal(out.l3Status, "timeout");
    assert.equal(out.layers.l1.length, 0);
    resetRecallProviderForTests();
  });

  it("does not throw on a throwing provider — returns error status", async () => {
    const provider: RecallProvider = {
      fetchL3: async () => {
        throw new Error("boom");
      },
      fetchL2: async () => [],
      fetchL1: async () => [],
    };
    setRecallProvider(provider);
    const out = await recallLayeredContext(
      { ownerId: "k", sessionId: "s", query: "q" },
      { timeoutMs: 100 }
    );
    assert.equal(out.l3Status, "error");
    assert.equal(out.layers.l3.length, 0);
    resetRecallProviderForTests();
  });
});

describe("recall — NOOP_RECALL_PROVIDER", () => {
  it("all layers are empty arrays", async () => {
    const out = await recallLayeredContext(
      { ownerId: "k", sessionId: "s", query: "q" },
      { timeoutMs: 50, provider: NOOP_RECALL_PROVIDER }
    );
    assert.deepEqual(out.layers.l1, []);
    assert.deepEqual(out.layers.l2, []);
    assert.deepEqual(out.layers.l3, []);
  });
});