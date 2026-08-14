/**
 * Regression coverage for #6135 against four-layer memory injection and the
 * outbound strict-system hoist.
 *
 * Xiaomi/MiMo requires every system message to be at index 0. Stable memory
 * context therefore stays in the leading system message, dynamic L1 recall is
 * rendered as user reference content, and any client-supplied mid-array system
 * message is hoisted at the outbound translation boundary.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hoistLeadingSystemMessage } from "../../open-sse/translator/helpers/strictSystemHoist.ts";
import {
  renderLayeredInjection,
  type InjectionBudgets,
  type LayerInjectionInput,
} from "../../src/memory/integration/injectionTransformer.ts";
import { systemMessageMustBeFirst } from "../../src/shared/utils/providerSystemMessages.ts";

interface ChatMessage extends Record<string, unknown> {
  role: string;
  content: string;
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

const LAYERS: LayerInjectionInput = {
  l3: [{ id: "l3-1", title: "Preferences", content: "Keep answers concise" }],
  l2: [],
  l1: [{ id: "l1-1", content: "User prefers dark mode", score: 0.9, tags: [] }],
  toolsGuide: "MEMORY TOOLS GUIDE",
};

function multiTurn(withLeadingSystem = true): ChatBody {
  return {
    model: "mimo-v2.5",
    messages: [
      ...(withLeadingSystem ? [{ role: "system", content: "SYSTEM PROMPT" }] : []),
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

function systemIndices(messages: ChatMessage[]): number[] {
  return messages.flatMap((message, index) => (message.role === "system" ? [index] : []));
}

function memoryIndex(messages: ChatMessage[]): number {
  return messages.findIndex(
    (message) =>
      typeof message.content === "string" && message.content.includes("<relevant-memories>")
  );
}

describe("four-layer memory strict system-first behavior (#6135)", () => {
  it("flags Xiaomi/MiMo aliases and leaves ordinary providers unconstrained", () => {
    assert.equal(systemMessageMustBeFirst("xiaomi-mimo"), true);
    assert.equal(systemMessageMustBeFirst("mimo"), true);
    assert.equal(systemMessageMustBeFirst(" MIMO "), true);
    assert.equal(systemMessageMustBeFirst("anthropic"), false);
    assert.equal(systemMessageMustBeFirst(null), false);
  });

  it("merges stable context into the leading system message for Xiaomi under caching", () => {
    const request = multiTurn();
    const result = renderLayeredInjection(request, LAYERS, BUDGETS, {
      provider: "xiaomi-mimo",
      hasCacheControl: true,
    });
    const messages = messagesFrom(result.body);
    const l1Index = memoryIndex(messages);

    assert.deepEqual(systemIndices(messages), [0]);
    assert.equal(result.systemPlacement, "leading-merged");
    assert.ok(messages[0].content.startsWith("SYSTEM PROMPT"));
    assert.match(messages[0].content, /\[L3 stable context\]/);
    assert.match(messages[0].content, /MEMORY TOOLS GUIDE/);
    assert.ok(l1Index > 0);
    assert.equal(messages[l1Index].role, "user");
    assert.match(messages[l1Index].content, /User prefers dark mode/);
    assert.equal(messages[messages.length - 1].content, "turn 2 question");
  });

  it("prepends a leading system message for the MiMo alias when none exists", () => {
    const result = renderLayeredInjection(multiTurn(false), LAYERS, BUDGETS, {
      provider: "mimo",
      isCachingProvider: true,
    });
    const messages = messagesFrom(result.body);

    assert.deepEqual(systemIndices(messages), [0]);
    assert.equal(result.systemPlacement, "leading-prepended");
    assert.match(messages[0].content, /\[L3 stable context\]/);
    assert.ok(memoryIndex(messages) > 0);
  });

  it("hoists a client-supplied mid-array system message after memory rendering", () => {
    const request: ChatBody = {
      model: "mimo-v2.5",
      messages: [
        { role: "user", content: "turn 1 question" },
        { role: "assistant", content: "turn 1 answer" },
        { role: "system", content: "CLIENT SYSTEM INSTRUCTIONS" },
        { role: "user", content: "turn 2 question" },
      ],
    };
    const rendered = renderLayeredInjection(request, LAYERS, BUDGETS, {
      provider: "xiaomi-mimo",
      hasCacheControl: true,
    });
    const renderedMessages = messagesFrom(rendered.body);

    assert.ok(systemIndices(renderedMessages).some((index) => index > 0));

    const outbound = hoistLeadingSystemMessage(renderedMessages, "xiaomi-mimo");
    assert.deepEqual(systemIndices(outbound), [0]);
    assert.match(outbound[0].content, /\[L3 stable context\]/);
    assert.match(outbound[0].content, /CLIENT SYSTEM INSTRUCTIONS/);
    assert.equal(outbound[outbound.length - 1].content, "turn 2 question");
  });

  it("keeps non-strict providers on pre-final-user cache-safe L1 placement", () => {
    const result = renderLayeredInjection(multiTurn(), LAYERS, BUDGETS, {
      provider: "anthropic",
      hasCacheControl: true,
    });
    const messages = messagesFrom(result.body);
    const l1Index = memoryIndex(messages);
    const lastUserIndex = messages.findLastIndex((message) => message.role === "user");

    assert.deepEqual(systemIndices(messages), [0]);
    assert.equal(l1Index, lastUserIndex - 1);
    assert.equal(messages[lastUserIndex].content, "turn 2 question");
  });
});
