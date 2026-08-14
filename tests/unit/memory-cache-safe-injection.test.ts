/**
 * Regression coverage for #3890 against the four-layer injection transformer.
 *
 * Stable L3/L2 context belongs in the leading system prefix. Per-query L1 recall
 * belongs immediately before the final user turn whenever prompt caching is active,
 * so changing recalled memories cannot displace the cacheable conversation prefix.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  renderLayeredInjection,
  type InjectionBudgets,
  type LayerInjectionInput,
} from "../../src/memory/integration/injectionTransformer.ts";

interface ChatMessage extends Record<string, unknown> {
  role: string;
  content: string;
  cache_control?: { type: string };
}

interface ChatBody extends Record<string, unknown> {
  model: string;
  messages: ChatMessage[];
}

const BUDGETS: InjectionBudgets = {
  l3CharBudget: 600,
  l2CharBudget: 600,
  l1CharBudget: 600,
  totalCharBudget: 8_000,
};

function layers(memory: string, includeStableContext = false): LayerInjectionInput {
  return {
    l3: includeStableContext
      ? [{ id: "l3-1", title: "Preferences", content: "Keep answers concise" }]
      : [],
    l2: [],
    l1: [{ id: `l1-${memory}`, content: memory, score: 0.9, tags: [] }],
    toolsGuide: includeStableContext ? "MEMORY TOOLS GUIDE" : "",
  };
}

function multiTurn(): ChatBody {
  return {
    model: "anthropic/claude-sonnet-4-6",
    messages: [
      {
        role: "system",
        content: "SYSTEM PROMPT",
        cache_control: { type: "ephemeral" },
      },
      { role: "user", content: "turn 1 question" },
      { role: "assistant", content: "turn 1 answer" },
      { role: "user", content: "turn 2 question" },
    ],
  };
}

function messagesFrom(body: Record<string, unknown>): ChatMessage[] {
  assert.ok(Array.isArray(body.messages));
  return body.messages as ChatMessage[];
}

describe("four-layer memory cache-safe positioning (#3890)", () => {
  it("places dynamic L1 immediately before the final user without shifting the prefix", () => {
    const request = multiTurn();
    const prefixBefore = request.messages.slice(0, 3);

    const result = renderLayeredInjection(request, layers("dark mode"), BUDGETS, {
      provider: "anthropic",
      hasCacheControl: true,
    });
    const messages = messagesFrom(result.body);

    assert.deepEqual(messages.slice(0, 3), prefixBefore);
    assert.equal(messages[3].role, "user");
    assert.match(messages[3].content, /<relevant-memories>/);
    assert.match(messages[3].content, /dark mode/);
    assert.equal(messages[4].content, "turn 2 question");
    assert.equal(messages.length, 5);
    assert.equal(result.l1Placement, "pre-last-user");
  });

  it("keeps the cache breakpoint byte-stable across recalls with different L1 content", () => {
    const turn1: ChatBody = {
      model: "anthropic/claude-sonnet-4-6",
      messages: [
        {
          role: "system",
          content: "SYSTEM PROMPT",
          cache_control: { type: "ephemeral" },
        },
        { role: "user", content: "turn 1 question" },
      ],
    };
    const turn2 = multiTurn();

    const out1 = messagesFrom(
      renderLayeredInjection(turn1, layers("memory A"), BUDGETS, {
        provider: "anthropic",
        hasCacheControl: true,
      }).body
    );
    const out2 = messagesFrom(
      renderLayeredInjection(turn2, layers("memory B"), BUDGETS, {
        provider: "anthropic",
        hasCacheControl: true,
      }).body
    );

    assert.equal(JSON.stringify(out1[0]), JSON.stringify(out2[0]));
    assert.deepEqual(out1[0], turn1.messages[0]);
    assert.deepEqual(out2.slice(0, 3), turn2.messages.slice(0, 3));
    assert.match(out1[1].content, /memory A/);
    assert.match(out2[3].content, /memory B/);
  });

  it("uses cache-safe placement for a caching provider without an explicit marker", () => {
    const result = renderLayeredInjection(multiTurn(), layers("dark mode"), BUDGETS, {
      provider: "anthropic",
      hasCacheControl: false,
      isCachingProvider: true,
    });
    const messages = messagesFrom(result.body);

    assert.equal(result.l1Placement, "pre-last-user");
    assert.match(messages[3].content, /<relevant-memories>/);
    assert.equal(messages[4].content, "turn 2 question");
  });

  it("keeps stable L3 context in the leading cached system message", () => {
    const result = renderLayeredInjection(multiTurn(), layers("per-query memory", true), BUDGETS, {
      provider: "anthropic",
      hasCacheControl: true,
    });
    const messages = messagesFrom(result.body);

    assert.equal(result.systemPlacement, "leading-merged");
    assert.equal(messages[0].role, "system");
    assert.equal(messages[0].cache_control?.type, "ephemeral");
    assert.ok(messages[0].content.startsWith("SYSTEM PROMPT"));
    assert.match(messages[0].content, /\[L3 stable context\]/);
    assert.match(messages[0].content, /MEMORY TOOLS GUIDE/);
    assert.match(messages[3].content, /per-query memory/);
    assert.equal(messages[4].content, "turn 2 question");
  });
});
